"""HealthMonitor: the rule table, snapshots, coalescing, threads and the runner fan-out."""
import ast
import errno
import logging
import sys
import threading
from dataclasses import FrozenInstanceError, replace
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from sc2tools_agent import health, runner
from sc2tools_agent.health import (ACTIONS, BOOT_HEADLINES, BootFailure, HealthFacts, HealthMonitor,
                                   HealthRow, classify_boot_error, evaluate)
from sc2tools_agent.state import AgentState
from sc2tools_agent.status_model import AgentStatus, StatusFacts
from sc2tools_agent.ui import SettingsPayload
from sc2tools_agent.ui.help_links import AGENT_HELP_SLUGS
from tests.test_upload_queue import _cfg

NOW = 1_800_000_000.0  # 2027-01-15T08:00:00Z
FOLDER = "C:/Users/me/Documents/StarCraft II/Accounts/1/2-S2-1-42/Replays/Multiplayer"
READY = HealthFacts(phase="ready", paired=True, folders=(FOLDER,), analyzer_ok=True, heartbeat_ok_at=NOW - 30)


def facts(**changes):
    return replace(READY, **changes)


def row(snapshot, rule_id):
    return next((item for item in snapshot.rows + snapshot.footer if item.id == rule_id), None)


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


class Scheduler:
    """Records requested recomputes; each test decides when they run."""

    def __init__(self):
        self.calls = []

    def __call__(self, delay, callback):
        self.calls.append((delay, callback))

    def run(self):
        calls, self.calls = self.calls, []
        for _delay, callback in calls:
            callback()


def monitor():
    clock, scheduler, seen = Clock(), Scheduler(), []
    watched = HealthMonitor(clock=clock, now=clock, schedule=scheduler)
    watched.subscribe(seen.append)
    return watched, clock, scheduler, seen


@pytest.mark.parametrize("changes,rule_id,level,action", [
    ({"unlinked": True}, "pairing", "warn", "link_pc"),
    ({"paired": False}, "pairing", "warn", "link_pc"),
    ({}, "pairing", "ok", None),
    ({"paused": True}, "paused", "warn", "resume"),
    ({"connection": "offline", "pending": 12}, "cloud", "warn", "retry_now"),
    ({"connection": "signed_out"}, "cloud", "warn", "retry_now"),
    ({"heartbeat_failing_since": NOW - 200}, "cloud", "warn", None),
    ({"socket_connected": False}, "cloud", "info", None),
    ({}, "cloud", "ok", None),
    ({"failure_times": (NOW - 30, NOW - 20, NOW - 10)}, "failures", "warn", "open_log"),
    ({"folders": ()}, "folders", "warn", "add_folder"),
    ({"missing_folders": ("D:/Replays",)}, "folders", "warn", "add_folder"),
    ({}, "folders", "ok", None),
    ({"unresolved_times": (NOW - 300, NOW - 200, NOW - 100)}, "identity", "warn", "set_player_name"),
    ({"identity_source": "none"}, "identity", "info", "set_player_name"),
    ({"identity_source": "cloud"}, "identity", "ok", None),
    ({"analyzer_ok": False}, "analyzer", "error", "open_log"),
    ({}, "analyzer", "ok", None),
    ({"pending": 4}, "uploads", "info", None),
    ({"archive_pending": 7}, "uploads", "info", None),
    ({"last_upload_at": NOW - 180}, "uploads", "ok", None),
    ({"archive_missing": 2, "archive_total": 9}, "archive", "info", None),
    ({"filter_label": "Season 67"}, "filter", "info", None),
    ({"update_version": "0.25.0"}, "updates", "info", "install_update"),
    ({"update_version": "0.25.0", "update_required": True}, "updates", "warn", "install_update"),
    ({"update_version": "0.25.0", "update_failed": True}, "updates", "warn", "install_update"),
    ({"live_enabled": False}, "live", "off", None),
    ({"live_enabled": True, "live_contact_at": NOW - 2}, "live", "ok", None),
    ({"live_enabled": True, "live_contact_at": NOW - 60}, "live", "off", None),
    ({"obs_enabled": False}, "obs", "off", None),
    ({"obs_enabled": True, "obs_auth_failed": True}, "obs", "warn", "open_obs_settings"),
    ({"obs_enabled": True, "obs_connected": False}, "obs", "info", "open_obs_settings"),
    ({"obs_enabled": True, "obs_connected": True}, "obs", "ok", None),
    ({"auto_update": False}, "auto_update", "off", None),
    ({"boot": BootFailure("network", "Check your internet connection.")}, "boot", "error", "restart_agent"),
    ({"phase": "boot_error"}, "boot", "error", "restart_agent"),
])
def test_each_rule_level_action_and_help(changes, rule_id, level, action):
    found = row(evaluate(facts(**changes), NOW), rule_id)
    assert (found.level, found.action) == (level, action) and found.level in health.LEVELS
    assert found.action is None or found.action in ACTIONS
    assert found.help_slug in AGENT_HELP_SLUGS
    # Connection problems point at the sync-problems article and identity and upload rows at the
    # missing-game one; the card gives those rows their own "?".
    assert (found.help_slug == "desktop-app-sync-problems") == (rule_id == "cloud" and level == "warn")
    assert (found.help_slug == "my-game-didnt-show-up") == (rule_id in ("identity", "uploads"))


def test_rule_sentences_are_plain_and_specific():
    cases = [
        ("cloud", facts(connection="offline", pending=312), "Can't reach sc2tools.com, so 312 replays are waiting."),
        ("cloud", facts(connection="server_busy", pending=1), "sc2tools.com is busy, so 1 replay is waiting."),
        ("cloud", facts(heartbeat_failing_since=NOW - 200), "Can't reach sc2tools.com right now; SC2 Tools keeps trying."),
        ("cloud", facts(heartbeat_failing_since=NOW - 60), "Connected to sc2tools.com."),
        ("failures", facts(failure_times=(NOW - 700, NOW - 30, NOW - 20, NOW - 10)),
         "3 uploads failed in the last 10 minutes."),
        ("folders", facts(folders=("x/1-S2-1-1/Replays", "x/2-S2-1-2/Replays")), "Watching 2 replay folders (EU, NA)."),
        ("folders", facts(missing_folders=("D:/Replays",)), "1 replay folder you added is missing."),
        ("identity", facts(unresolved_times=(NOW - 8 * 86400,) * 4 + (NOW - 60,) * 12),
         "12 games from the last week were skipped because SC2 Tools couldn't tell which player was you."),
        ("uploads", facts(), "Waiting for your next game."),
        ("uploads", facts(last_upload_at=NOW - 30), "Last upload just now."),
        ("uploads", facts(last_upload_at=NOW - 180), "Last upload 3 min ago."),
        ("uploads", facts(last_upload_at=NOW - 7200), "Last upload 2 h ago."),
        ("uploads", facts(last_upload_at=NOW - 3 * 86400), "Last upload 3 days ago."),
        ("archive", facts(archive_missing=1, archive_total=9),
         "1 of your 9 saved games needs one full Re-sync to back up its replay file."),
        ("filter", facts(filter_label="Season 67"), "Only games from Season 67 sync."),
        ("paused", facts(paused=True), "Sync is paused, so new replays wait until you resume."),
        ("paused", facts(paused=True, paused_until=NOW + 3600),
         f"Sync is paused until {datetime.fromtimestamp(NOW + 3600):%H:%M}."),
    ]
    for rule_id, case, sentence in cases:
        assert row(evaluate(case, NOW), rule_id).sentence == sentence


def test_unknown_or_quiet_facts_add_no_row():
    assert evaluate(HealthFacts(), NOW) == health.HealthSnapshot("Starting SC2 Tools…", 0, "ok", None)
    assert row(evaluate(facts(unresolved_times=(NOW - 60,) * 2), NOW), "identity") is None
    # Old skips (observed games, other people's replays) never warn, however many there are.
    assert row(evaluate(facts(unresolved_times=(NOW - 8 * 86400,) * 9,
                              skipped=(("player_unresolved", 9),)), NOW), "identity") is None
    # A pause freezes the queue's connection hold, so it never adds a cloud warning.
    paused = evaluate(facts(paused=True, connection="offline", pending=3), NOW)
    assert row(paused, "cloud") == HealthRow("cloud", "ok", "Connected to sc2tools.com.")
    assert (paused.attention, paused.headline) == (1, "1 thing needs attention")
    assert row(evaluate(facts(filter_label="All time"), NOW), "filter") is None
    assert row(evaluate(facts(failure_times=(NOW - 700,) * 5), NOW), "failures") is None
    assert row(evaluate(facts(obs_enabled=True), NOW), "obs") is None
    unpaired = evaluate(facts(paired=False, connection="offline", pending=3), NOW)
    assert row(unpaired, "cloud") is None and row(unpaired, "uploads") is None
    assert row(evaluate(facts(paused=True, pending=3), NOW), "uploads") is None


def test_rows_sort_by_level_then_table_order_and_off_rows_fill_the_footer():
    busy = evaluate(facts(analyzer_ok=False, paused=True, folders=(), filter_label="Season 67",
                          update_version="0.25.0", live_enabled=False, obs_enabled=False, auto_update=False), NOW)
    assert [item.id for item in busy.rows] == ["analyzer", "paused", "folders", "filter", "updates", "pairing", "cloud"]
    assert [item.id for item in busy.footer] == ["live", "obs", "auto_update"]
    calm = evaluate(facts(identity_source="cloud", last_upload_at=NOW - 60, live_enabled=True,
                          live_contact_at=NOW, obs_enabled=True, obs_connected=True), NOW)
    assert [item.id for item in calm.rows] == ["pairing", "cloud", "folders", "identity", "analyzer", "uploads",
                                               "live", "obs"]
    assert calm.footer == ()


def test_headline_counts_and_overall_level():
    def summary(**changes):
        snapshot = evaluate(facts(**changes), NOW)
        return snapshot.headline, snapshot.attention, snapshot.level
    assert summary() == ("Everything's working", 0, "ok")
    assert summary(pending=4) == ("Everything's working", 0, "info")
    assert summary(folders=()) == ("1 thing needs attention", 1, "warn")
    assert summary(folders=(), analyzer_ok=False) == ("2 things need attention", 2, "error")
    assert summary(phase="connecting") == ("Starting SC2 Tools…", 0, "ok")
    assert summary(phase="connecting", unlinked=True) == ("1 thing needs attention", 1, "warn")


@pytest.mark.parametrize("kind", ["analyzer", "state_dir", "network", "unknown"])
def test_a_boot_failure_replaces_every_other_row(kind):
    failed = evaluate(facts(boot=BootFailure(kind, "Summary."), folders=(), live_enabled=False), NOW)
    assert failed.headline == BOOT_HEADLINES[kind]
    assert failed.rows == (HealthRow("boot", "error", "Summary.", "restart_agent"),)
    assert (failed.footer, failed.attention, failed.level, failed.tray) == ((), 1, "error", "red")
    generic = evaluate(facts(phase="boot_error"), NOW)
    assert generic.headline == "SC2 Tools couldn't start syncing"
    assert generic.rows[0].sentence == "Open the Activity log for startup details."


@pytest.mark.parametrize("changes,tray", [
    ({}, "green"),
    ({"pending": 3}, "green"),
    ({"folders": ()}, "amber"),
    ({"paused": True}, "grey"),
    ({"paused": True, "connection": "offline"}, "grey"),
    ({"paused": True, "unlinked": True}, "amber"),
    ({"paused": True, "analyzer_ok": False}, "red"),
    ({"phase": "starting"}, None),
    ({"phase": "connecting", "pending": 2}, None),
    ({"phase": "connecting", "unlinked": True}, "amber"),
    ({"phase": "starting", "analyzer_ok": False}, "red"),
    ({"phase": "boot_error"}, "red"),
])
def test_tray_level(changes, tray):
    assert evaluate(facts(**changes), NOW).tray == tray


def test_snapshots_are_immutable_values():
    first, second = evaluate(facts(pending=2), NOW), evaluate(facts(pending=2), NOW)
    assert first == second and hash(first) == hash(second) and first is not second
    assert first != evaluate(facts(pending=3), NOW)
    with pytest.raises(FrozenInstanceError):
        first.headline = "changed"
    with pytest.raises(FrozenInstanceError):
        first.rows[0].sentence = "changed"


def test_pushes_inside_a_window_coalesce_and_the_last_facts_win():
    watched, clock, scheduler, seen = monitor()
    watched.set_pairing(True)
    for count in (1, 2, 3):
        watched.set_pending(count)
    assert [delay for delay, _ in scheduler.calls] == [0.0]
    assert seen == []  # nothing is computed on the pushing thread
    scheduler.run()
    assert len(seen) == 1 and row(seen[0], "uploads").sentence == "Uploading 3 replays."
    clock.now += 0.1
    for count in (4, 5, 6):
        watched.set_pending(count)
    assert [delay for delay, _ in scheduler.calls] == [pytest.approx(0.4, abs=1e-5)]
    scheduler.run()
    assert len(seen) == 2 and row(seen[1], "uploads").sentence == "Uploading 6 replays."
    clock.now += 1
    watched.set_pending(6)
    scheduler.run()
    assert len(seen) == 2 and watched.snapshot() == seen[-1]  # an equal snapshot is not emitted again


def test_a_push_from_a_subscriber_reaches_everyone_after_the_current_snapshot():
    clock, scheduler = Clock(), Scheduler()
    watched = HealthMonitor(clock=clock, now=clock, schedule=scheduler)
    first, second = [], []

    def pushes_once(snapshot):
        first.append(snapshot)
        if len(first) == 1:
            clock.now += 1
            watched.set_pending(9)
            scheduler.run()  # a synchronous scheduler re-enters the monitor

    watched.subscribe(pushes_once)
    watched.subscribe(second.append)
    watched.set_pairing(True)
    scheduler.run()
    assert second == first and len(first) == 2
    assert row(first[-1], "uploads").sentence == "Uploading 9 replays." and watched.snapshot() == first[-1]


def test_pushes_from_many_threads_never_lose_facts():
    watched, _clock, scheduler, seen = monitor()
    watched.set_pairing(True)
    pushes = [
        watched.set_pending,
        watched.set_archive_pending,
        lambda value: watched.set_filter_label(f"Season {value}"),
        lambda value: watched.set_skipped({"player_unresolved": value}),
        lambda value: watched.set_unresolved_skips([NOW - 60] * value),
        lambda value: watched.heartbeat_ok(at=float(value)),
        lambda value: watched.set_update(f"0.{value}.0"),
        lambda value: watched.upload_succeeded(at=NOW - 1000 + value),
        lambda value: watched.set_paused(value % 2 == 0),
    ]
    barrier = threading.Barrier(len(pushes))

    def worker(push):
        barrier.wait()
        for value in range(1, 501):
            push(value)

    threads = [threading.Thread(target=worker, args=(push,)) for push in pushes]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    final = watched.facts()
    assert (final.pending, final.archive_pending, final.filter_label) == (500, 500, "Season 500")
    assert (final.skipped, final.heartbeat_ok_at, final.update_version) == ((("player_unresolved", 500),), 500.0, "0.500.0")
    assert (final.last_upload_at, final.paused, final.paired) == (NOW - 500, True, True)
    assert len(final.unresolved_times) == health.MAX_FAILURE_TIMES  # only the newest are kept
    assert len(scheduler.calls) == 1  # the whole burst claimed one recompute
    scheduler.run()
    assert row(seen[-1], "identity").sentence.startswith(f"{health.MAX_FAILURE_TIMES} games from the last week")


def test_a_slow_older_recompute_never_overwrites_a_newer_snapshot(monkeypatch):
    watched, clock, scheduler, seen = monitor()
    watched.set_pairing(True)
    watched.set_pending(1)
    (_delay, older), = scheduler.calls
    scheduler.calls.clear()
    entered, release, real = threading.Event(), threading.Event(), health.evaluate

    def slow(current, now):
        if current.pending == 1:
            entered.set()
            release.wait(5)
        return real(current, now)

    monkeypatch.setattr(health, "evaluate", slow)
    thread = threading.Thread(target=older)
    thread.start()
    assert entered.wait(5)
    clock.now += 1
    watched.set_pending(2)
    scheduler.run()  # the newer recompute delivers first
    release.set()
    thread.join(5)  # the older one finishes last and must be dropped
    assert seen[-1] == watched.snapshot() and row(seen[-1], "uploads").sentence == "Uploading 2 replays."


def test_refresh_expires_old_failures_without_new_facts():
    watched, clock, scheduler, seen = monitor()
    watched.set_pairing(True)
    for _ in range(3):
        watched.upload_failed()
    scheduler.run()
    assert row(seen[-1], "failures").sentence == "3 uploads failed in the last 10 minutes."
    clock.now += 601
    watched.refresh()
    scheduler.run()
    assert row(seen[-1], "failures") is None


def test_heartbeat_failures_warn_only_after_the_grace_period():
    watched, clock, scheduler, seen = monitor()
    watched.set_pairing(True)
    watched.heartbeat_ok()
    clock.now += 60
    watched.heartbeat_failed("offline")
    scheduler.run()
    assert row(seen[-1], "cloud").level == "ok"
    clock.now += 160
    watched.heartbeat_failed("server_busy")
    scheduler.run()
    assert row(seen[-1], "cloud").sentence == "sc2tools.com is busy right now; SC2 Tools keeps trying."
    assert watched.facts().heartbeat_failing_since == NOW + 60
    watched.heartbeat_ok()
    scheduler.run()
    assert row(seen[-1], "cloud").sentence == "Connected to sc2tools.com."


def test_a_failing_scheduler_or_subscriber_never_breaks_a_push():
    attempts = []

    def broken(delay, _callback):
        attempts.append(delay)
        raise RuntimeError("can't start new thread")

    stuck = HealthMonitor(schedule=broken)
    stuck.set_pending(1)
    stuck.set_pending(2)
    assert attempts == [0.0, 0.0] and stuck.facts().pending == 2
    watched, _clock, scheduler, seen = monitor()
    later = []
    watched.subscribe(Mock(side_effect=RuntimeError("sink broke")))
    watched.subscribe(later.append)
    watched.set_pairing(True)
    scheduler.run()
    assert len(seen) == len(later) == 1


def test_the_default_timer_delivers_off_the_pushing_thread():
    delivered, names = threading.Event(), []
    watched = HealthMonitor()
    watched.subscribe(lambda _snapshot: (names.append(threading.current_thread().name), delivered.set()))
    watched.set_pairing(True)
    assert delivered.wait(2) and names == ["sc2tools-health"]


class _Busy(Exception):
    status = 503


class _Unprintable(Exception):
    def __str__(self):
        raise RuntimeError("no text")


def test_boot_failures_are_classified_without_leaking_paths(tmp_path):
    secret = str(tmp_path / "agent.json")
    network = "Check your internet connection, then restart SC2 Tools."
    cases = [
        (ModuleNotFoundError("No module named 'sc2reader'", name="sc2reader"), "analyzer",
         "The replay analyzer didn't load (No module named 'sc2reader')."),
        (PermissionError(13, "Permission denied", secret), "state_dir",
         "Windows blocked a file or folder SC2 Tools needs (Permission denied)."),
        (requests.ConnectionError("down"), "network", network),
        (requests.Timeout("slow"), "network", network),
        (ConnectionResetError("reset"), "network", network),
        (_Busy("http_503"), "network", network),
        (RuntimeError("X" * 300 + "\nsecond line"), "unknown", "X" * 140),
        (RuntimeError(""), "unknown", "Open the Activity log for startup details."),
        (_Unprintable(), "unknown", "Open the Activity log for startup details."),
    ]
    for exc, kind, summary in cases:
        assert classify_boot_error(exc) == BootFailure(kind, summary)
    namespace = {"__name__": "core.sc2_replay_parser"}
    exec("def parse():\n    raise ValueError('bad build data')", namespace)
    with pytest.raises(ValueError) as raised:
        namespace["parse"]()
    assert classify_boot_error(raised.value) == BootFailure("analyzer", "The replay analyzer didn't load (bad build data).")
    missing = FileNotFoundError(2, "No such file or directory", secret)
    assert classify_boot_error(missing).kind == "unknown"  # could be a replay folder
    assert classify_boot_error(missing, state_dir=tmp_path) == BootFailure(
        "state_dir", "SC2 Tools can't use its data folder (No such file or directory).")
    assert classify_boot_error(OSError(errno.ENOSPC, "No space left on device")).kind == "state_dir"
    # Any other file error keeps only its reason, so no path (user name, toon handle) reaches the row.
    assert classify_boot_error(missing) == BootFailure(
        "unknown", "SC2 Tools couldn't open a file it needs (No such file or directory).")
    for exc in (missing, PermissionError(13, "Permission denied", secret), IsADirectoryError(21, "Is a directory", secret)):
        for state_dir in (None, tmp_path, tmp_path / "elsewhere"):
            assert secret not in classify_boot_error(exc, state_dir=state_dir).summary


def test_health_module_imports_only_the_standard_library():
    tree = ast.parse(Path(health.__file__).read_text(encoding="utf-8"))
    absolute = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import)
                for alias in node.names}
    absolute |= {node.module.split(".")[0] for node in ast.walk(tree)
                 if isinstance(node, ast.ImportFrom) and not node.level}
    relative = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level}
    assert absolute <= set(sys.stdlib_module_names) and relative == {"folder_info"}


def _multiplexer(*sinks, **kwargs):
    clock, scheduler = Clock(), Scheduler()
    ui = runner._Multiplexer(*sinks, health=HealthMonitor(clock=clock, now=clock, schedule=scheduler), **kwargs)
    return ui, scheduler


def test_multiplexer_pushes_hook_facts_and_fans_out_one_snapshot():
    sink, plain = Mock(), Mock()
    del plain.on_health  # a sink without the hook is skipped, like on_status_view
    ui, scheduler = _multiplexer(sink, plain, facts=StatusFacts(paired=True, phase="ready", folders=[Path("2-S2-1-42")]))
    ui.on_phase("ready")
    ui.on_analyzer_probe(True, "")
    ui.on_filter_label("Season 67")
    ui.on_pending(3)
    ui.on_connection_state("offline", NOW - 60, NOW + 30, 3)
    for name in ("a", "b", "c"):
        ui.on_upload_failed(name, SimpleNamespace(counts_as_error=True, title="Rejected"))
    ui.on_recent_snapshot({"skipped": [{"reason": "player_unresolved", "count": 4}],
                           "rows": [{"status": "skipped", "reason": "player_unresolved",
                                     "updatedAt": f"2027-01-15T07:5{minute}:00+00:00"} for minute in range(4)],
                           "facts": {"lastUploadAt": "2027-01-15T07:57:00+00:00"}})
    ui.on_update_available("0.25.0", required=True)
    ui.on_replay_archive_status(2, 9)
    sink.on_health.assert_not_called()
    scheduler.run()
    sink.on_health.assert_called_once()
    snapshot = sink.on_health.call_args.args[0]
    assert [(item.id, item.level) for item in snapshot.rows] == [
        ("cloud", "warn"), ("failures", "warn"), ("identity", "warn"), ("updates", "warn"),
        ("archive", "info"), ("filter", "info"), ("pairing", "ok"), ("folders", "ok"), ("analyzer", "ok")]
    assert (snapshot.headline, snapshot.tray) == ("4 things need attention", "amber")
    assert ui.health.facts().last_upload_at == NOW - 180
    # The existing status view still reaches every sink unchanged.
    view = sink.on_status_view.call_args.args[0]
    assert view.status == AgentStatus.NEEDS_ATTENTION and plain.on_status_view.call_args.args[0] == view


def test_multiplexer_pause_turns_the_health_tray_grey_for_every_sink():
    one, two = Mock(), Mock()
    ui, scheduler = _multiplexer(one, two, facts=StatusFacts(paired=True, phase="ready", folders=[Path("2-S2-1-42")]))
    ui.on_paused(True, None)
    scheduler.run()
    assert one.on_health.call_args.args[0] == two.on_health.call_args.args[0]
    assert one.on_health.call_args.args[0].tray == "grey"


def test_signed_out_offers_retry_until_the_unlink_is_confirmed():
    sink = Mock()
    ui, scheduler = _multiplexer(sink, facts=StatusFacts(paired=True, phase="ready", folders=[Path("2-S2-1-42")]))
    ui.on_connection_state("signed_out", NOW - 60, NOW + 30, 5)
    scheduler.run()

    def actions():
        return [(item.id, item.action) for item in sink.on_health.call_args.args[0].rows if item.action]

    # Link again now would keep the rejected token, so the cloud row only retries.
    assert actions() == [("cloud", "retry_now")]
    ui.on_unlinked()  # the auth watchdog confirmed the revocation
    scheduler.run()
    assert actions() == [("pairing", "link_pc")]


def test_relinking_clears_a_signed_out_hold():
    sink = Mock()
    ui, scheduler = _multiplexer(sink, facts=StatusFacts(paired=True, phase="ready", folders=[Path("2-S2-1-42")]))
    ui.on_pending(5)
    ui.on_connection_state("signed_out", NOW - 60, NOW + 30, 5)
    ui.on_unlinked()
    ui.on_paired("user")
    scheduler.run()
    snapshot = sink.on_health.call_args.args[0]
    assert all(item.action != "link_pc" for item in snapshot.rows) and snapshot.attention == 0
    assert row(snapshot, "pairing").sentence == "This PC is linked to your account."


def test_one_failing_sink_never_starves_the_others():
    broken, healthy = Mock(), Mock()
    broken.on_health.side_effect = RuntimeError("sink broke")
    ui, scheduler = _multiplexer(broken, healthy, facts=StatusFacts(paired=True, phase="ready"))
    ui.on_paused(True, None)
    scheduler.run()
    broken.on_health.assert_called_once()
    assert healthy.on_health.call_args.args[0].tray == "grey"


def test_heartbeat_hooks_run_recovery_then_record_health():
    clock, scheduler = Clock(), Scheduler()
    ui = SimpleNamespace(health=HealthMonitor(clock=clock, now=clock, schedule=scheduler))
    calls = []
    beat_ok, beat_failed = runner._health_heartbeat(ui, lambda: calls.append("ok"), calls.append)
    beat_ok()
    error = requests.ConnectionError("down")
    beat_failed(error)
    final = ui.health.facts()
    assert calls == ["ok", error] and final.heartbeat_ok_at == NOW
    assert (final.heartbeat_failed_at, final.heartbeat_failing_since, final.error_kind) == (NOW, NOW, "offline")
    broken = runner._health_heartbeat(ui, Mock(side_effect=RuntimeError("recovery broke")), calls.append)[0]
    clock.now += 60
    with pytest.raises(RuntimeError):
        broken()  # Heartbeat turns this into a failure, so no success is recorded
    assert ui.health.facts().heartbeat_ok_at == NOW


def test_feature_facts_fill_the_footer_and_follow_settings(tmp_path):
    ui, scheduler = _multiplexer(Mock(), facts=StatusFacts(paired=True, phase="ready"))
    runner._push_feature_facts(ui, AgentState(auto_update_enabled=False), no_live=True)
    scheduler.run()
    assert [item.sentence for item in ui.health.snapshot().footer] == [
        "Live game features are off.", "Automatic updates are off."]
    cell = SimpleNamespace(upload=None, watcher=None, gui=None, tray=None, ui=ui)
    runner._handle_save_settings(_cfg(tmp_path), AgentState(), SettingsPayload(auto_update_enabled=True), cell,
                                 logging.getLogger("test"))
    scheduler.run()
    assert [item.id for item in ui.health.snapshot().footer] == ["live", "obs"]
    assert [item.sentence for item in ui.health.snapshot().footer] == [
        "Live game features are off.", "OBS scene switching is off."]


def test_the_boot_error_path_reports_a_classified_failure(tmp_path, monkeypatch):
    def denied(**_kwargs):
        raise PermissionError(13, "Permission denied", str(tmp_path / "agent.json"))

    monkeypatch.setattr(runner, "ApiClient", denied)
    sink = Mock()
    ui, scheduler = _multiplexer(sink)
    runner._gui_boot_worker(cfg=_cfg(tmp_path), state=AgentState(), cell=runner._RuntimeCell(), ui=ui,
                            stop_event=threading.Event(), log=logging.getLogger("test"), no_live=True, no_obs=True)
    scheduler.run()
    snapshot = sink.on_health.call_args.args[0]
    assert snapshot.headline == BOOT_HEADLINES["state_dir"]
    assert snapshot.rows == (HealthRow("boot", "error", "Windows blocked a file or folder SC2 Tools needs "
                                       "(Permission denied).", "restart_agent"),)
    assert sink.on_status_view.call_args.args[0].status == AgentStatus.ERROR
