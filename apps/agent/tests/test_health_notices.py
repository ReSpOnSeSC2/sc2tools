"""Health toasts: once per new problem, settled, grouped, held during a match; tray tooltip names it."""
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent import runner
from sc2tools_agent.health import (UNLINKED_SENTENCE, BootFailure, HealthFacts, HealthMonitor, HealthSnapshot,
                                   evaluate)
from sc2tools_agent.health_notices import (NOTIFY_ROW_IDS, TITLE, HealthNotices, fit_utf16, problem_rows,
                                           toast_message)
from sc2tools_agent.status_model import StatusFacts
from sc2tools_agent.ui.tray import TOOLTIP_MAX, TrayUI

NOW = 1_800_000_000.0
FOLDER = "C:/Users/me/Documents/StarCraft II/Accounts/1/2-S2-1-42/Replays/Multiplayer"
READY = HealthFacts(phase="ready", paired=True, folders=(FOLDER,), analyzer_ok=True, heartbeat_ok_at=NOW - 30)


def snap(**changes):
    return evaluate(replace(READY, **changes), NOW)


@pytest.mark.parametrize("changes,keys", [
    ({}, []),
    ({"unlinked": True}, ["unlinked"]),
    ({"paired": False}, []),  # first-run linking is the window's job, not a toast
    ({"boot": BootFailure("network", "Check your internet connection.")}, ["boot"]),
    ({"analyzer_ok": False}, ["analyzer"]),
    ({"update_version": "0.25.7", "update_failed": True}, ["updates"]),
    ({"update_version": "0.25.7", "update_required": True}, ["updates"]),
    ({"update_version": "0.25.7"}, []),  # ready to install is good news
    ({"obs_enabled": True, "obs_auth_failed": True}, ["obs"]),
    ({"obs_enabled": True, "obs_connected": False}, []),
    ({"folders": ()}, ["folders"]),
    ({"missing_folders": ("D:/Replays",)}, ["folders"]),
    ({"paused": True}, []),
    ({"setup_pending": True}, []),
    ({"connection": "offline", "pending": 3}, []),
    ({"failure_times": (NOW - 30, NOW - 20, NOW - 10)}, []),
    ({"unresolved_times": (NOW - 300, NOW - 200, NOW - 100)}, []),
    ({"analyzer_ok": False, "folders": (), "unlinked": True}, ["analyzer", "unlinked", "folders"]),
])
def test_which_rows_toast(changes, keys):
    assert list(problem_rows(snap(**changes))) == keys
    assert NOTIFY_ROW_IDS == {"boot", "analyzer", "updates", "obs", "folders"}


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class Scheduler:
    def __init__(self):
        self.calls = []

    def __call__(self, delay, callback):
        timer = SimpleNamespace(delay=delay, callback=callback, cancelled=False)
        timer.cancel = lambda: setattr(timer, "cancelled", True)
        self.calls.append(timer)
        return timer

    def fire(self):
        calls, self.calls = self.calls, []
        for timer in calls:
            if not timer.cancelled:
                timer.callback()
        return [timer.delay for timer in calls]


def notices(busy=lambda: False):
    clock, scheduler, toasts = Clock(), Scheduler(), []
    watcher = HealthNotices(notify=toasts.append, busy=busy, clock=clock, schedule=scheduler)
    return watcher, clock, scheduler, toasts


def test_one_toast_after_the_problem_settles_and_none_while_it_stays():
    watcher, clock, scheduler, toasts = notices()
    watcher.on_health(snap(unlinked=True))
    assert toasts == [] and [timer.delay for timer in scheduler.calls] == [20.0]
    clock.now += 20
    scheduler.fire()
    assert toasts == [UNLINKED_SENTENCE]
    for _ in range(3):
        clock.now += 60
        watcher.on_health(snap(unlinked=True, pending=4))
    assert toasts == [UNLINKED_SENTENCE] and scheduler.calls == []


def test_a_problem_that_clears_first_never_toasts_and_one_that_returns_toasts_again_a_day_later():
    watcher, clock, scheduler, toasts = notices()
    watcher.on_health(snap(folders=()))
    clock.now += 5
    watcher.on_health(snap())  # discovery found the folder
    clock.now += 30
    scheduler.fire()
    assert toasts == []
    watcher.on_health(snap(analyzer_ok=False))
    clock.now += 20
    scheduler.fire()
    assert len(toasts) == 1
    watcher.on_health(snap())
    watcher.on_health(snap(analyzer_ok=False))  # back within the day: no second toast
    clock.now += 20
    scheduler.fire()
    assert len(toasts) == 1
    clock.now += 24 * 3600
    watcher.on_health(snap())
    watcher.on_health(snap(analyzer_ok=False))
    clock.now += 19
    scheduler.fire()
    assert len(toasts) == 1
    clock.now += 1
    scheduler.fire()
    assert toasts == ["The replay analyzer didn't load, so new replays can't be read."] * 2


def test_an_update_that_keeps_failing_toasts_once_a_day_and_a_new_version_at_once():
    watcher, clock, scheduler, toasts = notices()

    def check_fails_again():  # every 12 h the version is offered again ("ready"), then fails again
        watcher.on_health(snap(update_version="0.25.7", update_failed=True))
        clock.now += 20
        scheduler.fire()
        watcher.on_health(snap(update_version="0.25.7"))
        clock.now += 12 * 3600

    check_fails_again()
    check_fails_again()
    assert toasts == ["Version 0.25.7 couldn't install."]
    check_fails_again()  # a day after the first toast
    assert toasts == ["Version 0.25.7 couldn't install."] * 2
    watcher.on_health(snap(update_version="0.25.8", update_failed=True))
    clock.now += 20
    scheduler.fire()
    assert toasts[-1] == "Version 0.25.8 couldn't install." and len(toasts) == 3


def test_problems_due_together_share_one_toast_worst_first():
    watcher, clock, scheduler, toasts = notices()
    watcher.on_health(snap(folders=()))
    clock.now += 2
    watcher.on_health(snap(folders=(), analyzer_ok=False))
    clock.now += 18
    scheduler.fire()  # only the folder row has settled
    assert toasts == ["No replay folder found; add your StarCraft II Replays folder."]
    clock.now += 2
    scheduler.fire()
    assert toasts[-1] == "The replay analyzer didn't load, so new replays can't be read."
    watcher2, clock2, scheduler2, toasts2 = notices()
    watcher2.on_health(snap(unlinked=True, update_version="0.25.7", update_failed=True, obs_enabled=True,
                            obs_auth_failed=True))
    clock2.now += 20
    scheduler2.fire()
    assert toasts2 == [f"{UNLINKED_SENTENCE} Open SC2 Tools to see 2 more."]


def test_toasts_wait_for_the_match_and_drop_problems_that_cleared_meanwhile():
    match = {"busy": True}
    watcher, clock, scheduler, toasts = notices(busy=lambda: match["busy"])
    watcher.on_health(snap(update_version="0.25.7", update_failed=True, folders=()))
    clock.now += 20
    assert scheduler.fire() == [20.0] and toasts == []
    assert [timer.delay for timer in scheduler.calls] == [15.0]  # re-check after the match
    watcher.on_health(snap(update_version="0.25.7", update_failed=True))  # folder came back mid-match
    clock.now += 15
    scheduler.fire()
    assert toasts == [] and len(scheduler.calls) == 1
    match["busy"] = False
    clock.now += 15
    scheduler.fire()
    assert toasts == ["Version 0.25.7 couldn't install."] and scheduler.calls == []


def test_a_broken_notifier_or_match_check_never_breaks_health_delivery():
    def explode(_message):
        raise RuntimeError("tray gone")

    clock, scheduler = Clock(), Scheduler()
    watcher = HealthNotices(notify=explode, busy=lambda: 1 / 0, clock=clock, schedule=scheduler)
    watcher.on_health(snap(analyzer_ok=False))
    clock.now += 20
    scheduler.fire()  # logged, not raised; an unknown match state counts as no match
    failing = HealthNotices(notify=explode, clock=clock, schedule=lambda *_: 1 / 0)
    failing.on_health(snap(analyzer_ok=False))  # a failed schedule is logged


def test_close_cancels_the_pending_check_and_silences_later_snapshots():
    watcher, clock, scheduler, toasts = notices()
    watcher.on_health(snap(analyzer_ok=False))
    pending = scheduler.calls[0]
    watcher.close()
    assert pending.cancelled
    clock.now += 60
    pending.callback()
    watcher.on_health(snap(analyzer_ok=False, folders=()))
    assert toasts == []


def test_messages_fit_windows_limits():
    long_row = SimpleNamespace(sentence="x" * 300)
    assert len(toast_message([long_row])) == 255 and toast_message([long_row]).endswith("…")
    assert fit_utf16("short", 10) == "short"
    assert fit_utf16("😀" * 70, 127).endswith("…")
    assert len(fit_utf16("😀" * 70, 127).encode("utf-16-le")) // 2 <= 127
    assert len(TITLE) < 64


def test_tray_tooltip_names_the_first_problem_under_the_headline():
    tray = TrayUI(dashboard_url="https://example.test")
    tray.on_health(snap(unlinked=True, paused=True))
    assert tray._tooltip() == "SC2 Tools - 2 things need attention\n" + UNLINKED_SENTENCE
    tray.on_health(snap(boot=BootFailure("network", "Check your internet connection, then restart SC2 Tools.")))
    assert tray._tooltip() == ("SC2 Tools - SC2 Tools couldn't reach sc2tools.com\n"
                               "Check your internet connection, then restart SC2 Tools.")
    tray.on_health(snap())
    assert tray._tooltip() == "SC2 Tools - Everything's working"
    tray.on_health(snap(unresolved_times=(NOW - 60,) * 12))
    tooltip = tray._tooltip()
    assert len(tooltip.encode("utf-16-le")) // 2 <= TOOLTIP_MAX == 127 and tooltip.endswith("…")
    assert tooltip.startswith("SC2 Tools - 1 thing needs attention\n12 games from the last week")
    tray.on_health(HealthSnapshot("1 thing needs attention", 1, "warn", "amber"))
    assert tray._tooltip() == "SC2 Tools - 1 thing needs attention"


def test_runner_toasts_through_the_tray_and_holds_during_a_match():
    tray = Mock()
    ui = runner._Multiplexer(Mock(), tray, facts=StatusFacts(paired=True),
                             health=HealthMonitor(schedule=lambda delay, callback: callback()))
    gate = SimpleNamespace(busy=True)
    watcher = runner._start_health_notices(ui, tray, lambda: gate)
    assert ui._health_notices is watcher
    watcher._settle, watcher._schedule = 0.0, lambda delay, callback: SimpleNamespace(cancel=lambda: None)
    ui.on_unlinked()
    tray.show_notice.assert_not_called()  # a match is running
    gate.busy = False
    watcher._fire()
    tray.show_notice.assert_called_once_with(UNLINKED_SENTENCE, title="SC2 Tools needs attention")
    watcher.close()
    no_gate = runner._start_health_notices(ui, tray, lambda: None)
    assert no_gate._is_busy() is False
    no_gate.close()
