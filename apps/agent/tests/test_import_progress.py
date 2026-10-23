import threading

from sc2tools_agent.import_progress import ImportRate
from sc2tools_agent.import_controller import ImportController


def test_eta_waits_for_several_samples_then_uses_measured_throughput():
    now = [0]
    rate = ImportRate(clock=lambda: now[0])
    assert rate.observe(0, 100)["etaSeconds"] is None
    for done in (2, 4):
        now[0] += 5
        assert rate.observe(done, 100 - done)["etaSeconds"] is None
    now[0] = 15
    measured = rate.observe(6, 94)
    assert round(measured["ratePerMinute"]) == 24
    assert measured["etaSeconds"] == 235


def test_five_minute_window_decays_idle_rate_and_reset_cannot_show_negative_eta():
    now = [0]
    rate = ImportRate(clock=lambda: now[0])
    rate.observe(0, 100)
    now[0] = 10
    assert rate.observe(10, 90)["ratePerMinute"] == 60
    now[0] = 310
    assert 22 < rate.observe(10, 90)["ratePerMinute"] < 23
    now[0] = 315
    assert rate.observe(0, 100)["etaSeconds"] is None


def test_pause_is_not_mistaken_for_zero_upload_throughput():
    now = [0]
    rate = ImportRate(clock=lambda: now[0])
    rate.observe(0, 100)
    now[0] = 10
    rate.observe(10, 90)
    now[0] = 610
    assert rate.observe(10, 90, active=False) == {"ratePerMinute": None, "etaSeconds": None}
    now[0] = 620
    assert rate.observe(20, 80)["ratePerMinute"] == 60


def test_controller_snapshot_is_local_nonblocking_and_change_callback_runs_without_lock():
    reading = threading.Event()
    release = threading.Event()
    class Watcher:
        def count_pending(self):
            reading.set()
            assert release.wait(3)
            return 1000
    class API:
        def import_progress(self, _body):
            raise AssertionError("snapshot() must never ask the cloud")
    updates = []
    controller = ImportController(api=API(), watcher=Watcher(), on_change=lambda value: updates.append((value, controller.snapshot())))
    worker = threading.Thread(target=controller._try_count_pending)
    worker.start()
    try:
        assert reading.wait(1)
        assert controller.snapshot()["phase"] == "scanning"
        assert updates[-1][0] == updates[-1][1]
    finally:
        release.set()
        worker.join(timeout=2)
    assert not worker.is_alive()


def test_manual_resync_below_cloud_threshold_tracks_and_completes_offline(monkeypatch):
    from pathlib import Path
    from tests.test_import_controller import FakeApi, FakeWatcher, wait_for
    monkeypatch.setattr("sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", .02)
    api, watcher = FakeApi(), FakeWatcher(pending=2)
    def offline(_body):
        raise ConnectionError("offline fixture")
    monkeypatch.setattr(api, "import_agent_start", offline)
    controller = ImportController(api=api, watcher=watcher)
    try:
        controller.maybe_start_auto_backfill(force_display=True)
        assert controller.snapshot()["total"] == 2
        assert controller.snapshot()["phase"] == "importing"
        controller.on_upload_success(Path("a"))
        controller.on_upload_success(Path("b"))
        watcher.pending = 0
        assert wait_for(lambda: controller.snapshot()["phase"] == "done")
        assert controller.snapshot()["completed"] == 2
        assert api.progress_calls == []  # Local job IDs are never sent to API.
    finally:
        controller.stop()


def test_empty_offline_manual_resync_finishes_without_an_indefinite_spinner(monkeypatch):
    from tests.test_import_controller import FakeApi, FakeWatcher
    api = FakeApi()
    def offline(_body):
        raise ConnectionError("offline fixture")
    monkeypatch.setattr(api, "import_agent_start", offline)
    controller = ImportController(api=api, watcher=FakeWatcher(pending=0))
    controller.maybe_start_auto_backfill(force_display=True)
    assert controller.snapshot()["phase"] == "done"
    assert controller.snapshot()["remaining"] == 0
    assert not api.progress_calls


def test_startup_history_continues_local_accounting_when_cloud_registration_fails(monkeypatch):
    from pathlib import Path
    from tests.test_import_controller import FakeApi, FakeWatcher, wait_for
    monkeypatch.setattr("sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", .02)
    api, watcher = FakeApi(), FakeWatcher(pending=30)
    def offline(_body):
        raise ConnectionError("offline fixture")
    monkeypatch.setattr(api, "import_agent_start", offline)
    controller = ImportController(api=api, watcher=watcher)
    try:
        controller.maybe_start_auto_backfill()  # Normal startup, not manual Re-sync.
        for index in range(30):
            controller.on_upload_success(Path(str(index)))
        watcher.pending = 0
        assert wait_for(lambda: controller.snapshot()["phase"] == "done")
        assert controller.snapshot()["completed"] == 30
        assert api.progress_calls == []
    finally:
        controller.stop()


def test_controller_hold_excludes_pause_and_outage_from_rate_samples():
    from tests.test_import_controller import FakeApi, FakeWatcher
    now = [0]
    controller = ImportController(api=FakeApi(), watcher=FakeWatcher())
    controller._rate = ImportRate(clock=lambda: now[0])
    body = {"phase": "import", "completed": 0, "remaining": 100}
    controller._publish_local(body)
    now[0] = 10
    body.update(completed=10, remaining=90)
    controller._publish_local(body)
    assert controller.snapshot()["ratePerMinute"] == 60
    controller.set_hold(paused=True)
    now[0] = 610
    controller._publish_local(body)
    assert controller.snapshot()["ratePerMinute"] is None
    controller.set_hold(paused=False, connection="offline")
    now[0] = 1210
    controller._publish_local(body)
    assert controller.snapshot()["ratePerMinute"] is None
    controller.set_hold(connection="online")
    now[0] = 1220
    controller._publish_local({**body, "completed": 20, "remaining": 80})
    assert controller.snapshot()["ratePerMinute"] == 60
