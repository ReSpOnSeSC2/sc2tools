from datetime import datetime, timedelta, timezone
import os
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from sc2tools_agent.first_run import FirstRunSetup, SetupChoices, describe_setup_folder, prepare_first_run, setup_range
from sc2tools_agent.state import AgentState


def test_first_pairing_stays_pending_across_restart_and_existing_pairing_migrates():
    state = AgentState()
    writes = []
    assert prepare_first_run(state, lambda: writes.append(state.setup_pending), now=10)
    assert writes == [True]
    state = AgentState(device_token="synthetic", setup_pending=True)
    assert prepare_first_run(state, lambda: pytest.fail("Already marked pending"), now=20)
    legacy = AgentState(device_token="synthetic")
    assert not prepare_first_run(legacy, lambda: pytest.fail("Do not gate the legacy watcher"), now=30)
    assert legacy.setup_completed_at == 30


def test_failed_pending_marker_write_keeps_fresh_setup_retryable():
    state = AgentState()
    def fail():
        raise OSError("disk")
    with pytest.raises(OSError):
        prepare_first_run(state, fail)
    assert not state.setup_pending
    assert prepare_first_run(state, lambda: None)


def test_watcher_gate_waits_for_durable_choices_and_respects_quit():
    gate_calls = []
    def save(choices):
        gate_calls.append(choices)
        if len(gate_calls) == 1:
            raise OSError("first save fails")
        return setup_range(choices.preset)

    gate = FirstRunSetup(folders=["fixture"], start_with_windows=True, save=save)
    quit_event = Event()
    booted = Event()
    results = []
    def boot():
        results.append(gate.wait(quit_event))
        booted.set()
    thread = Thread(target=boot, daemon=True)
    thread.start()
    choices = SetupChoices(("fixture",), "last_30_days", False)
    assert not booted.wait(0.03)
    with pytest.raises(OSError):
        gate.complete(choices)
    assert not booted.wait(0.03)
    assert gate.complete(choices)[0] == choices
    assert booted.wait(1) and results == [True]
    quit_event.set()
    assert not FirstRunSetup(folders=[], start_with_windows=None, save=save).wait(quit_event)


def test_setup_counts_from_file_dates_and_keeps_the_only_new_timestamp(tmp_path):
    clock = datetime(2026, 11, 11, 16, tzinfo=timezone.utc)
    folder = tmp_path / "1-S2-1-1" / "Replays" / "Multiplayer"
    folder.mkdir(parents=True)
    for filename, day in (("recent.SC2Replay", 3), ("old.SC2Replay", 90), ("ignored.txt", 1)):
        replay = folder / filename
        replay.write_bytes(b"synthetic")
        stamp = (clock - timedelta(days=day)).timestamp()
        os.utime(replay, (stamp, stamp))
    details, counts = describe_setup_folder(folder, now=clock)
    assert details.replay_count == 2
    assert details.toon == "1-S2-1-1"
    assert counts["all"] == 2 and counts["last_30_days"] == 1 and counts["since_setup"] == 0
    replay_range = setup_range("since_setup", now=clock)
    assert replay_range.resolve() == (clock, None)
    assert not replay_range.replay_in_range((clock - timedelta(seconds=1)).isoformat())
    assert replay_range.replay_in_range(clock.isoformat())


def test_boot_worker_never_starts_watcher_when_pending_setup_is_cancelled(tmp_path, monkeypatch):
    import logging
    from sc2tools_agent import runner

    state = AgentState(device_token="synthetic", setup_pending=True)
    stop = Event()
    requested = []
    def dispatch(signal, request):
        requested.append((signal, request))
        stop.set()
    cell = SimpleNamespace(gui=SimpleNamespace(_dispatch=dispatch))
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://example.test")
    pending = []
    ui = SimpleNamespace(on_status=lambda _: None, on_phase=lambda _: None,
                         health=SimpleNamespace(set_setup_pending=pending.append))
    monkeypatch.setattr(runner, "ApiClient", lambda **_: object())
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [tmp_path])
    monkeypatch.setattr(runner.autostart, "is_supported", lambda: False)
    monkeypatch.setattr(runner, "probe_analyzer", lambda: pytest.fail("Boot reached the analyzer before setup"))
    runner._gui_boot_worker(cfg=cfg, state=state, cell=cell, ui=ui, stop_event=stop, log=logging.getLogger(__name__))
    assert len(requested) == 1 and requested[0][0] == "setupRequested"
    assert requested[0][1].folders == (str(tmp_path),)
    assert pending == [True]  # the status card offers Finish setup until the choices arrive


def test_boot_worker_clears_finish_setup_once_the_choices_are_saved(tmp_path, monkeypatch):
    import logging
    from sc2tools_agent import runner

    class Reached(Exception):
        pass

    state = AgentState(device_token="synthetic", setup_pending=True)
    pushes = []
    health = SimpleNamespace(set_setup_pending=lambda value: pushes.append(("setup", value)),
                             set_boot_error=lambda failure: pushes.append(("boot", failure.kind)))

    def dispatch(signal, request):
        pushes.append(("dispatch", signal))
        request.complete(SetupChoices((str(tmp_path),), "since_setup", None))

    def probe():
        pushes.append(("probe", None))
        raise Reached("stop after setup")

    cell = SimpleNamespace(gui=SimpleNamespace(_dispatch=dispatch))
    ui = SimpleNamespace(on_status=lambda _: None, on_phase=lambda *_: None, health=health)
    monkeypatch.setattr(runner, "ApiClient", lambda **_: object())
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [tmp_path])
    monkeypatch.setattr(runner.autostart, "is_supported", lambda: False)
    monkeypatch.setattr(runner, "_save_first_run", lambda *_: setup_range("since_setup"))
    monkeypatch.setattr(runner, "probe_analyzer", probe)
    runner._gui_boot_worker(cfg=SimpleNamespace(state_dir=tmp_path, api_base="https://example.test"), state=state,
                            cell=cell, ui=ui, stop_event=Event(), log=logging.getLogger(__name__))
    assert pushes[:4] == [("setup", True), ("dispatch", "setupRequested"), ("setup", False), ("probe", None)]


def test_a_finished_request_reports_finished():
    gate = FirstRunSetup(folders=[], start_with_windows=None, save=lambda choices: setup_range(choices.preset))
    assert not gate.finished
    gate.refresh()  # nothing to re-read
    gate.complete(SetupChoices((), "all", None))
    assert gate.finished


def test_a_reopened_setup_rereads_folders_and_startup_until_it_is_finished():
    current = {"value": (["C:/Replays/A"], False)}
    gate = FirstRunSetup(folders=["C:/Replays/A"], start_with_windows=False,
                         save=lambda choices: setup_range(choices.preset), refresh=lambda: current["value"])
    current["value"] = (["C:/Replays/A", "D:/Replays"], True)  # Add folder and Settings while it waited
    gate.refresh()
    assert gate.folders == ("C:/Replays/A", "D:/Replays") and gate.start_with_windows is True
    gate.complete(SetupChoices(gate.folders, "all", True))
    current["value"] = ([], None)
    gate.refresh()
    assert gate.folders == ("C:/Replays/A", "D:/Replays") and gate.start_with_windows is True


def test_finishing_compares_with_the_folders_the_reopened_wizard_showed(tmp_path, monkeypatch):
    import logging
    from sc2tools_agent import runner

    state = AgentState(device_token="synthetic", setup_pending=True)
    added = tmp_path / "added"
    folders = {"value": [tmp_path]}
    saved, requests = [], []
    monkeypatch.setattr(runner, "ApiClient", lambda **_: object())
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: list(folders["value"]))
    monkeypatch.setattr(runner.autostart, "is_supported", lambda: False)
    monkeypatch.setattr(runner, "_save_first_run",
                        lambda cfg, state, choices, shown, ui: saved.append((choices, shown)) or setup_range("all"))

    def dispatch(_signal, request):
        requests.append(request)
        folders["value"] = [tmp_path, added]  # Add folder while setup waited
        request.refresh()  # what Finish setup does before it reopens the wizard
        request.complete(SetupChoices((str(tmp_path),), "all", None))

    class Reached(Exception):
        pass

    monkeypatch.setattr(runner, "probe_analyzer", lambda: (_ for _ in ()).throw(Reached("stop after setup")))
    ui = SimpleNamespace(on_status=lambda _: None, on_phase=lambda *_: None,
                         health=SimpleNamespace(set_setup_pending=lambda _value: None,
                                                set_boot_error=lambda _failure: None))
    runner._gui_boot_worker(cfg=SimpleNamespace(state_dir=tmp_path, api_base="https://example.test"), state=state,
                            cell=SimpleNamespace(gui=SimpleNamespace(_dispatch=dispatch)), ui=ui,
                            stop_event=Event(), log=logging.getLogger(__name__))
    assert requests[0].folders == (str(tmp_path), str(added))
    assert saved and saved[0][1] == [tmp_path, added]  # unchecking the added folder is a real choice
