"""ImportController — job visibility over the existing pipeline.

The controller never parses or uploads anything itself; these tests
exercise the accounting (benign vs error skip reasons), the socket
event handlers, and the auto-backfill registration threshold, with the
api/watcher stubbed.
"""

from __future__ import annotations

import time
from pathlib import Path

from sc2tools_agent.import_controller import (
    AUTO_BACKFILL_MIN,
    ImportController,
)


class FakeApi:
    def __init__(self, *, agent_start_resp=None, fail_progress=False):
        self.progress_calls = []
        self.agent_start_calls = []
        self.host_info_calls = []
        self._agent_start_resp = agent_start_resp or {"ok": True, "jobId": "job1"}
        self._fail_progress = fail_progress

    def import_progress(self, body):
        if self._fail_progress:
            raise RuntimeError("offline")
        self.progress_calls.append(body)
        return {"ok": True}

    def import_agent_start(self, body):
        self.agent_start_calls.append(body)
        return self._agent_start_resp

    def import_host_info(self, body):
        self.host_info_calls.append(body)
        return {"ok": True}


class FakeWatcher:
    def __init__(self, pending=0):
        self.pending = pending
        self.sweep_requests = 0

    def count_pending(self):
        return self.pending

    def request_immediate_sweep(self):
        self.sweep_requests += 1


def make_controller(*, pending=0, api=None, full_resync=None):
    api = api or FakeApi()
    watcher = FakeWatcher(pending=pending)
    ctl = ImportController(
        api=api,
        watcher=watcher,
        full_resync=full_resync,
        list_folders=lambda: ["C:/replays"],
    )
    return ctl, api, watcher


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_scan_reports_candidate_count_and_done():
    ctl, api, _w = make_controller(pending=42)
    ctl.handle_scan_request({"jobId": "scan1"})
    assert len(api.progress_calls) == 1
    body = api.progress_calls[0]
    assert body["jobId"] == "scan1"
    assert body["total"] == 42
    assert body["done"] is True


def test_start_with_zero_candidates_finishes_immediately():
    ctl, api, w = make_controller(pending=0)
    ctl.handle_start_request({"jobId": "job0"})
    assert api.progress_calls[-1]["done"] is True
    assert api.progress_calls[-1]["total"] == 0
    # No sweep needed for an empty import.
    assert w.sweep_requests == 0


def test_start_tracks_counters_and_reports_done(monkeypatch):
    # Speed the reporter loop up so the test doesn't sleep 2s per tick.
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.05,
    )
    ctl, api, w = make_controller(pending=3)
    ctl.handle_start_request({"jobId": "job3"})
    assert w.sweep_requests == 1

    ctl.on_upload_success(Path("a.SC2Replay"))
    ctl.on_replay_skipped(Path("b.SC2Replay"), "ai_game")     # benign
    ctl.on_replay_skipped(Path("c.SC2Replay"), "parse_failed")  # error

    assert wait_for(
        lambda: any(c.get("done") for c in api.progress_calls if c["jobId"] == "job3"),
    ), f"reporter never finished: {api.progress_calls!r}"
    final = [c for c in api.progress_calls if c.get("done") and c["jobId"] == "job3"][-1]
    assert final["completed"] == 2  # upload + vs-AI skip
    assert final["errors"] == 1
    assert final["errorBreakdown"] == {"ai_game": 1, "parse_failed": 1}
    samples = final["errorSamples"]
    assert len(samples) == 1  # benign reasons don't produce samples
    assert samples[0]["file"] == "c.SC2Replay"
    assert samples[0]["errorCode"] == "parse_failed"
    ctl.stop()


def test_force_start_runs_full_resync():
    calls = []
    ctl, _api, _w = make_controller(
        pending=1, full_resync=lambda: calls.append(1),
    )
    ctl.handle_start_request({"jobId": "jf", "force": True})
    assert calls == [1]
    ctl.stop()


def test_cancel_stops_tracking():
    ctl, api, _w = make_controller(pending=5)
    ctl.handle_start_request({"jobId": "jc"})
    ctl.handle_cancel_request({"jobId": "jc"})
    before = len(api.progress_calls)
    # Counters after cancel are no-ops (job no longer active).
    ctl.on_upload_success(Path("a.SC2Replay"))
    assert len(api.progress_calls) == before
    ctl.stop()


def test_hooks_are_noops_without_active_job():
    ctl, api, _w = make_controller()
    ctl.on_upload_success(Path("a.SC2Replay"))
    ctl.on_upload_failure(Path("b.SC2Replay"), RuntimeError("x"))
    ctl.on_replay_skipped(Path("c.SC2Replay"), "parse_failed")
    assert api.progress_calls == []


def test_auto_backfill_below_threshold_does_not_register():
    ctl, api, _w = make_controller(pending=AUTO_BACKFILL_MIN - 1)
    ctl.maybe_start_auto_backfill()
    assert api.agent_start_calls == []


def test_auto_backfill_registers_job_at_threshold():
    ctl, api, _w = make_controller(pending=AUTO_BACKFILL_MIN)
    ctl.maybe_start_auto_backfill()
    assert api.agent_start_calls == [{"total": AUTO_BACKFILL_MIN}]
    # Adopted the cloud-minted jobId — counters now flow.
    ctl.on_upload_success(Path("a.SC2Replay"))
    ctl.stop()


def test_auto_backfill_survives_missing_route():
    class Api404(FakeApi):
        def import_agent_start(self, body):  # noqa: ARG002
            raise RuntimeError("404 not_found")

    api = Api404()
    ctl, _api, _w = make_controller(pending=AUTO_BACKFILL_MIN, api=api)
    # Older API without the route: log-and-continue, never raise.
    ctl.maybe_start_auto_backfill()


def test_pick_folder_reports_host_info():
    ctl, api, _w = make_controller()
    ctl.handle_pick_folder_request({"reqId": "r1"})
    assert api.host_info_calls == [{"replayFolders": ["C:/replays"]}]


def test_progress_post_failure_never_raises():
    api = FakeApi(fail_progress=True)
    ctl, _api, _w = make_controller(pending=2, api=api)
    # _post_progress swallows network errors (reporting is best-effort).
    ctl.handle_start_request({"jobId": "jx"})
    ctl.stop()
