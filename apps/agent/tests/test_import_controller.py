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
        self.fail_count = False

    def count_pending(self):
        if self.fail_count:
            raise RuntimeError("inventory unavailable")
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


def test_scan_inventory_failure_stays_unfinished():
    ctl, api, watcher = make_controller(pending=42)
    watcher.fail_count = True
    ctl.handle_scan_request({"jobId": "scan-unknown"})

    body = api.progress_calls[-1]
    assert body == {
        "jobId": "scan-unknown",
        "total": 0,
        "phase": "scan",
        "message": "inventory_unavailable",
        "stalled": True,
    }
    assert "done" not in body


def test_start_with_zero_candidates_finishes_immediately():
    ctl, api, w = make_controller(pending=0)
    ctl.handle_start_request({"jobId": "job0"})
    assert api.progress_calls[-1]["done"] is True
    assert api.progress_calls[-1]["total"] == 0
    # No sweep needed for an empty import.
    assert w.sweep_requests == 0


def test_start_inventory_failure_never_reports_nothing_to_import(monkeypatch):
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.02,
    )
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._INVENTORY_RETRY_SEC", 0.05,
    )
    ctl, api, watcher = make_controller(pending=3)
    watcher.fail_count = True
    ctl.handle_start_request({"jobId": "start-unknown"})

    first = api.progress_calls[-1]
    assert first["stalled"] is True
    assert first["message"] == "inventory_unavailable"
    assert "done" not in first
    assert watcher.sweep_requests == 1

    watcher.fail_count = False
    assert wait_for(
        lambda: any(
            call.get("message") == "import_inventory_recovered"
            for call in api.progress_calls
        ),
    )
    recovered = api.progress_calls[-1]
    assert recovered["total"] == 3
    assert recovered["stalled"] is False
    assert "done" not in recovered
    ctl.stop()


def test_start_tracks_counters_and_reports_done(monkeypatch):
    # Speed the reporter loop up so the test doesn't sleep 2s per tick.
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.05,
    )
    ctl, api, w = make_controller(pending=4)
    ctl.handle_start_request({"jobId": "job3"})
    assert w.sweep_requests == 1

    ctl.on_upload_success(Path("a.SC2Replay"))
    ctl.on_replay_skipped(Path("b.SC2Replay"), "ai_game")     # benign
    ctl.on_replay_skipped(Path("r.SC2Replay"), "resumed_replay")  # benign
    ctl.on_replay_skipped(Path("c.SC2Replay"), "parse_failed")  # error
    w.pending = 0

    assert wait_for(
        lambda: any(c.get("done") for c in api.progress_calls if c["jobId"] == "job3"),
    ), f"reporter never finished: {api.progress_calls!r}"
    final = [c for c in api.progress_calls if c.get("done") and c["jobId"] == "job3"][-1]
    assert final["completed"] == 3  # upload + two intentional skips
    assert final["errors"] == 1
    assert final["errorBreakdown"] == {
        "ai_game": 1,
        "resumed_replay": 1,
        "parse_failed": 1,
    }
    samples = final["errorSamples"]
    assert len(samples) == 1  # benign reasons don't produce samples
    assert samples[0]["file"] == "c.SC2Replay"
    assert samples[0]["errorCode"] == "parse_failed"
    ctl.stop()


def test_transient_upload_failure_is_not_counted(monkeypatch):
    """A transient batch failure (bare exception → job will be retried)
    must NOT count as an error. Otherwise read-timeout retry noise fills
    the card with "files couldn't be imported", and the file is
    double-counted when its retry later succeeds (once as an error, once
    as a completion)."""
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.05,
    )
    ctl, api, w = make_controller(pending=1)
    ctl.handle_start_request({"jobId": "jt"})

    # Same file: a transient failure, then the eventual retry-success.
    ctl.on_upload_failure(Path("a.SC2Replay"), TimeoutError("read timed out"))
    ctl.on_upload_success(Path("a.SC2Replay"))
    w.pending = 0

    assert wait_for(
        lambda: any(c.get("done") for c in api.progress_calls if c["jobId"] == "jt"),
    ), f"reporter never finished: {api.progress_calls!r}"
    final = [c for c in api.progress_calls if c.get("done") and c["jobId"] == "jt"][-1]
    assert final["completed"] == 1  # counted once, as a success
    assert final["errors"] == 0     # the transient hit never tallied
    assert not final.get("errorBreakdown")
    assert not final.get("errorSamples")
    ctl.stop()


def test_terminal_upload_rejection_counts_as_error(monkeypatch):
    """A server rejection is a ``TerminalUploadError`` — the file is done
    and won't be retried, so it must count as an error and surface a
    sample the user can act on."""
    from sc2tools_agent.uploader.queue import _ServerRejectedError

    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.05,
    )
    ctl, api, w = make_controller(pending=1)
    ctl.handle_start_request({"jobId": "jr"})

    ctl.on_upload_failure(
        Path("bad.SC2Replay"),
        _ServerRejectedError("oppBuildLog must NOT have more than 5000 items"),
    )
    w.pending = 0

    assert wait_for(
        lambda: any(c.get("done") for c in api.progress_calls if c["jobId"] == "jr"),
    ), f"reporter never finished: {api.progress_calls!r}"
    final = [c for c in api.progress_calls if c.get("done") and c["jobId"] == "jr"][-1]
    assert final["errors"] == 1
    assert final["completed"] == 0
    assert final["errorBreakdown"] == {"rejected_by_server": 1}
    assert final["errorSamples"][0]["file"] == "bad.SC2Replay"
    ctl.stop()


def test_filtered_upload_counts_as_benign_completion(monkeypatch):
    """A sync-window filter drop is a ``TerminalUploadError`` but an
    INTENTIONAL exclusion, not a failure. It must count as a completion
    under its own ``filtered`` bucket — never as an error and never with
    the misleading ``rejected_by_server`` code or an error sample."""
    from sc2tools_agent.uploader.queue import _FilteredOutError

    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.05,
    )
    ctl, api, w = make_controller(pending=1)
    ctl.handle_start_request({"jobId": "jff"})

    ctl.on_upload_failure(
        Path("outofrange.SC2Replay"),
        _FilteredOutError("Outside sync window 2026"),
    )
    w.pending = 0

    assert wait_for(
        lambda: any(c.get("done") for c in api.progress_calls if c["jobId"] == "jff"),
    ), f"reporter never finished: {api.progress_calls!r}"
    final = [c for c in api.progress_calls if c.get("done") and c["jobId"] == "jff"][-1]
    assert final["completed"] == 1  # processed, as the filter intended
    assert final["errors"] == 0
    assert final["errorBreakdown"] == {"filtered": 1}
    # Benign outcomes never produce an actionable error sample.
    assert not final.get("errorSamples")
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
    from sc2tools_agent.uploader.queue import _ServerRejectedError

    ctl, api, _w = make_controller()
    ctl.on_upload_success(Path("a.SC2Replay"))
    # Even a TERMINAL failure is a no-op when no job is active.
    ctl.on_upload_failure(Path("b.SC2Replay"), _ServerRejectedError("x"))
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


def test_auto_backfill_seeds_counters_when_adopting_existing_job(monkeypatch):
    """An agent restart mid-backfill (auto-update) re-registers and the
    cloud hands back the SAME running job with its prior progress. The
    controller must continue counting from that progress — absolute
    reports restarting at zero dragged the web card's numbers
    backwards, then forwards again, as the new run caught up.
    """
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.05,
    )
    api = FakeApi(agent_start_resp={
        "ok": True, "jobId": "job-adopted", "existing": True,
        "total": 12661, "completed": 3000, "errors": 18,
    })
    ctl, api, _w = make_controller(pending=AUTO_BACKFILL_MIN, api=api)
    ctl.maybe_start_auto_backfill()
    ctl.on_upload_success(Path("a.SC2Replay"))
    assert wait_for(lambda: any(
        c["jobId"] == "job-adopted" and c.get("completed") == 3001
        for c in api.progress_calls
    )), f"seeded counters never reported: {api.progress_calls!r}"
    body = [c for c in api.progress_calls if c["jobId"] == "job-adopted"][-1]
    assert body["errors"] == 18
    # total = prior processed (3000 + 18) + what's still on disk — the
    # cloud's stale total (12661) is NOT trusted, the disk recount is.
    assert body["total"] == 3000 + 18 + AUTO_BACKFILL_MIN
    ctl.stop()


def test_auto_backfill_fresh_job_starts_at_zero():
    """A brand-new backfill job (existing absent/false) seeds nothing."""
    api = FakeApi(agent_start_resp={
        "ok": True, "jobId": "job-new", "existing": False,
    })
    ctl, api, _w = make_controller(pending=AUTO_BACKFILL_MIN, api=api)
    ctl.maybe_start_auto_backfill()
    ctl.on_upload_success(Path("a.SC2Replay"))
    assert wait_for(lambda: any(
        c["jobId"] == "job-new" and c.get("completed") == 1
        and c.get("total") == AUTO_BACKFILL_MIN
        for c in api.progress_calls
    )), f"fresh-job counters wrong: {api.progress_calls!r}"
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


# ---------------- stall guard ----------------------------------------
#
# ``total`` is a point-in-time estimate; settle-failures, backpressure
# drops, and a wedged upload worker all leave ``processed < total``
# forever. Pre-guard, the reporter heartbeated ``import:progress``
# every 10 s until the agent was restarted — the web app refreshed
# continuously even with nothing left to sync.


def _speed_up_reporter(monkeypatch, stall_sec=0.1):
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.01,
    )
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._STALL_TIMEOUT_SEC", stall_sec,
    )


def test_stalled_job_reports_background_state_without_done(monkeypatch):
    """No counter movement for the stall window + files still pending
    on disk → report an honest, recoverable stalled state and stop
    posting unchanged heartbeats. Background tracking stays attached."""
    _speed_up_reporter(monkeypatch)
    ctl, api, _w = make_controller(pending=7)
    ctl.handle_start_request({"jobId": "stall1"})

    assert wait_for(lambda: any(c.get("stalled") for c in api.progress_calls)), (
        f"stalled job never reported: {api.progress_calls!r}"
    )
    final = api.progress_calls[-1]
    assert not final.get("done")
    assert final["stalled"] is True
    assert final["remaining"] == 7
    assert final["message"] == "import_stalled_background_continues"
    assert ctl._job_id == "stall1"

    # Reporter stays attached for recovery but must be silent while the
    # counters and inventory are unchanged (the endless-refresh fix).
    n = len(api.progress_calls)
    time.sleep(0.05)
    assert len(api.progress_calls) == n
    ctl.stop()


def test_auto_backfill_restart_recovers_existing_stalled_job(monkeypatch):
    monkeypatch.setattr(
        "sc2tools_agent.import_controller._REPORT_INTERVAL_SEC", 0.01,
    )
    api = FakeApi(agent_start_resp={
        "ok": True,
        "jobId": "job-stalled",
        "existing": True,
        "status": "stalled",
        "total": 100,
        "completed": 20,
        "errors": 1,
    })
    ctl, api, w = make_controller(pending=AUTO_BACKFILL_MIN, api=api)
    ctl.maybe_start_auto_backfill()

    # Merely re-attaching after restart is not proof of movement, so the
    # stalled state remains truthful until a terminal callback arrives.
    time.sleep(0.05)
    assert api.progress_calls == []

    w.pending = AUTO_BACKFILL_MIN - 1
    ctl.on_upload_success(Path("recovered.SC2Replay"))
    assert wait_for(lambda: any(
        c.get("stalled") is False
        and c.get("message") == "import_progress_resumed"
        for c in api.progress_calls
    )), f"stalled job was not resumed: {api.progress_calls!r}"
    resumed = api.progress_calls[-1]
    assert resumed["completed"] == 21
    assert resumed["errors"] == 1
    assert resumed["remaining"] == AUTO_BACKFILL_MIN - 1
    ctl.stop()


def test_stalled_job_returns_to_running_when_progress_resumes(monkeypatch):
    _speed_up_reporter(monkeypatch)
    ctl, api, w = make_controller(pending=7)
    ctl.handle_start_request({"jobId": "recover1"})
    assert wait_for(lambda: any(c.get("stalled") for c in api.progress_calls))

    w.pending = 6
    ctl.on_upload_success(Path("recovered.SC2Replay"))
    assert wait_for(lambda: any(
        c.get("stalled") is False and c.get("completed") == 1
        for c in api.progress_calls
    )), f"recovery never reported: {api.progress_calls!r}"
    resumed = [c for c in api.progress_calls if c.get("stalled") is False][-1]
    assert resumed["message"] == "import_progress_resumed"
    assert resumed["remaining"] == 6
    assert ctl._job_id == "recover1"
    ctl.stop()


def test_stalled_job_with_nothing_pending_closes_as_complete(monkeypatch):
    """Counters under-count (settle-failures etc. are invisible), so a
    stall with ZERO files left on disk means the import actually
    finished — close it as complete, not stalled."""
    _speed_up_reporter(monkeypatch)
    ctl, api, w = make_controller(pending=5)
    ctl.handle_start_request({"jobId": "stall2"})
    # Everything on disk got handled, but only via uncounted paths.
    w.pending = 0

    assert wait_for(lambda: ctl._job_id is None), (
        f"stalled job never closed: {api.progress_calls!r}"
    )
    final = api.progress_calls[-1]
    assert final["done"] is True
    assert final["remaining"] == 0
    assert final["message"] == "import_complete"


def test_inventory_failure_never_manufactures_completion(monkeypatch):
    _speed_up_reporter(monkeypatch)
    ctl, api, w = make_controller(pending=5)
    ctl.handle_start_request({"jobId": "unknown1"})
    w.fail_count = True

    time.sleep(0.2)
    assert ctl._job_id == "unknown1"
    assert not any(c.get("done") for c in api.progress_calls)
    ctl.stop()


def test_unchanged_running_job_does_not_send_heartbeats(monkeypatch):
    _speed_up_reporter(monkeypatch, stall_sec=10.0)
    ctl, api, _w = make_controller(pending=5)
    ctl.handle_start_request({"jobId": "quiet1"})
    assert len(api.progress_calls) == 1

    time.sleep(0.1)
    assert len(api.progress_calls) == 1
    ctl.stop()


def test_moving_job_does_not_trip_stall_guard(monkeypatch):
    """Steady progress resets the stall clock — a healthy backfill
    must complete via the normal processed >= total path."""
    _speed_up_reporter(monkeypatch, stall_sec=10.0)
    ctl, api, w = make_controller(pending=2)
    ctl.handle_start_request({"jobId": "move1"})
    ctl.on_upload_success(Path("a.SC2Replay"))
    ctl.on_upload_success(Path("b.SC2Replay"))
    w.pending = 0

    assert wait_for(lambda: ctl._job_id is None)
    final = [c for c in api.progress_calls if c.get("done")][-1]
    assert final["jobId"] == "move1"
    assert not final.get("stalled")
    assert final["remaining"] == 0


def test_apparent_completion_recounts_and_expands_for_new_files(monkeypatch):
    """A live replay can finish while a long resync is running. Reaching
    the original point-in-time total must not complete while disk inventory
    still contains work."""
    _speed_up_reporter(monkeypatch, stall_sec=10.0)
    ctl, api, w = make_controller(pending=2)
    ctl.handle_start_request({"jobId": "grow1"})
    ctl.on_upload_success(Path("a.SC2Replay"))
    ctl.on_upload_success(Path("new-live.SC2Replay"))

    assert wait_for(lambda: any(
        c.get("total") == 4 and not c.get("done")
        for c in api.progress_calls
    )), f"total was not reconciled: {api.progress_calls!r}"
    assert ctl._job_id == "grow1"

    w.pending = 0
    ctl.on_upload_success(Path("b.SC2Replay"))
    ctl.on_upload_success(Path("c.SC2Replay"))
    assert wait_for(lambda: ctl._job_id is None)
    assert api.progress_calls[-1]["done"] is True
    assert api.progress_calls[-1]["remaining"] == 0
