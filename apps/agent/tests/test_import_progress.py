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
