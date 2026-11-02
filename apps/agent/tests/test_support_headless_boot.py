"""Actual runner seam with inert boot dependencies; no normal agent starts."""
from types import SimpleNamespace
import threading

import pytest

from sc2tools_agent.health import HealthFacts
from sc2tools_agent.state import AgentState
from sc2tools_agent.support_diagnostics import diagnostic_bytes


def boot_seams(monkeypatch, tmp_path, *, paired=False):
    from sc2tools_agent import runner
    state = AgentState(user_id="synthetic-owner" if paired else None, device_token="synthetic-token" if paired else None)
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.example.test", parse_concurrency=2, replay_folder=None)
    ui = SimpleNamespace(health=SimpleNamespace(facts=lambda: HealthFacts()), _support=None,
        on_paused=lambda *_args: None, on_status=lambda *_args: None, on_phase=lambda *_args: None,
        show_pairing_code=lambda *_args: None, on_pairing_state=lambda *_args: None, on_paired=lambda *_args: None)
    trays = []

    class Tray:
        def __init__(self, **_kwargs):
            self.service, self.started = None, False
            trays.append(self)

        def set_support_service(self, service):
            self.service = service

        def start(self, **_kwargs):
            assert self.service is not None and ui._support is self.service
            self.started = True

    monkeypatch.setattr(runner, "load_state", lambda _path: state)
    monkeypatch.setattr(runner, "_discover_replay_folders", lambda *_args: [])
    monkeypatch.setattr(runner, "detected_replay_folders", lambda *_args: [])
    monkeypatch.setattr(runner, "_effective_obs_connection", lambda _state: ("localhost", 4455, None))
    monkeypatch.setattr(runner, "ConsoleUI", lambda: SimpleNamespace(request_stop=lambda: None))
    monkeypatch.setattr(runner, "can_use_tray", lambda: True)
    monkeypatch.setattr(runner, "TrayUI", Tray)
    monkeypatch.setattr(runner, "_Multiplexer", lambda *_args, **_kwargs: ui)
    monkeypatch.setattr(runner, "_push_feature_facts", lambda *_args: None)
    monkeypatch.setattr(runner, "_start_pause_expiry", lambda *_args: None)
    return runner, cfg, trays


def test_headless_tray_can_copy_before_initial_pairing_and_early_return_closes_service(tmp_path, monkeypatch):
    runner, cfg, trays = boot_seams(monkeypatch, tmp_path)
    results = []

    def pairing(**_kwargs):
        assert trays[0].started
        service = trays[0].service
        delivered = threading.Event()
        assert service.copy_info(lambda result: (results.append(result), delivered.set())) is not None
        assert delivered.wait(3)
        return False

    monkeypatch.setattr(runner, "ensure_paired", pairing)
    assert runner._run_headless(cfg, tmp_path) == 0
    service = trays[0].service
    assert service._closed and not service.busy
    assert len(results) == 1 and b"SC2 Tools support diagnostics v1" in diagnostic_bytes(results[0].snapshot)
    assert results[0].snapshot.support.user_hash8 is None


@pytest.mark.parametrize("stage", ["pairing", "analyzer"])
def test_headless_early_boot_failure_waits_for_owned_support_worker(tmp_path, monkeypatch, stage):
    runner, cfg, trays = boot_seams(monkeypatch, tmp_path, paired=stage == "analyzer")
    entered, release, exited = threading.Event(), threading.Event(), threading.Event()
    results, failures = [], []

    def fail_boot(*_args, **_kwargs):
        service = trays[0].service
        assert trays[0].started

        def held():
            entered.set()
            assert release.wait(3)
            return ()

        service.discover_folders = held
        assert service.copy_info(results.append) is not None
        assert entered.wait(3)
        raise RuntimeError("synthetic early boot failure")

    monkeypatch.setattr(runner, "ensure_paired" if stage == "pairing" else "probe_analyzer", fail_boot)

    def run():
        try:
            runner._run_headless(cfg, tmp_path)
        except RuntimeError as error:
            failures.append(str(error))
        finally:
            exited.set()

    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert entered.wait(3)
        assert trays[0].service.busy and not exited.wait(0.03)
    finally:
        release.set()
    thread.join(3)
    assert not thread.is_alive() and exited.is_set()
    assert failures == ["synthetic early boot failure"] and results == []
    assert trays[0].service._closed and not trays[0].service.busy
