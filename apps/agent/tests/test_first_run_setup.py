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
    ui = SimpleNamespace(on_status=lambda _: None, on_phase=lambda _: None)
    monkeypatch.setattr(runner, "ApiClient", lambda **_: object())
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_: [tmp_path])
    monkeypatch.setattr(runner.autostart, "is_supported", lambda: False)
    monkeypatch.setattr(runner, "probe_analyzer", lambda: pytest.fail("Boot reached the analyzer before setup"))
    runner._gui_boot_worker(cfg=cfg, state=state, cell=cell, ui=ui, stop_event=stop, log=logging.getLogger(__name__))
    assert len(requested) == 1 and requested[0][0] == "setupRequested"
    assert requested[0][1].folders == (str(tmp_path),)
