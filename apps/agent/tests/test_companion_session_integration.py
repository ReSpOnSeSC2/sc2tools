from __future__ import annotations

from datetime import datetime, timezone
import time

import pytest

from tests.test_companion_page import companion
from PySide6 import QtWidgets


def capture_jobs(page, monkeypatch):
    calls = []

    def job(channel, payload):
        page._sequence += 1
        page._requests[channel] = page._sequence
        calls.append({"channel": channel, "request": page._sequence, "payload": payload})

    monkeypatch.setattr(page, "_job", job)
    page._account_key = "owned-account-session"
    page._paired = True
    page._snapshot_healthy = True
    page._preferences["overlaysEnabled"] = True
    return calls


def session_result(owner="owned-account-session", wins=2):
    return {"paired": True, "accountKey": owner, "source": "overlay-session", "receivedAt": time.time(),
            "session": {"wins": wins, "losses": 1, "games": wins + 1,
                        "sessionStartedAt": datetime.fromtimestamp(time.time() - 7025, timezone.utc).isoformat()}}


def finish(page, call, result=None, error=None):
    page._completed({**call, **({"error": error} if error else {"result": result})})


def test_session_tracks_owned_cloud_record_and_master_hides_without_erasing_choice(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    page.session_check.setChecked(True)
    assert page.session_panel.isVisible()
    stats = next(call for call in calls if call["channel"] == "session_stats")
    finish(page, stats, session_result())
    assert page.session_panel.wins_label.text() == "2W" and page.session_panel.losses_label.text() == "1L"
    assert page.session_panel.elapsed_label.text() == "1h 57m"
    save = next(call for call in calls if call["channel"] == "session_save")
    finish(page, save, {"enabled": True})
    page._preferences["overlaysEnabled"] = False
    page._sync_session_panel()
    assert not page.session_panel.isVisible()
    assert page.session_check.isChecked() and page._session_saved is True
    page._preferences["overlaysEnabled"] = True
    page._sync_session_panel()
    assert page.session_panel.isVisible()
    assert page.session_panel.wins_label.text() == "2W"


@pytest.mark.parametrize("mutation", ["account", "unpair", "off", "connection"])
def test_late_session_response_never_reappears_after_owner_or_visibility_change(companion, monkeypatch, mutation):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    page.session_check.setChecked(True)
    pending = next(call for call in calls if call["channel"] == "session_stats")
    if mutation == "account":
        page._clear_library()
        page._account_key = "new-account"
    elif mutation == "unpair":
        page._clear_library()
        page._paired = False
    elif mutation == "off":
        page.session_check.setChecked(False)
    else:
        page._snapshot_healthy = False
        page._sync_session_panel()
    finish(page, pending, session_result())
    assert page.session_panel.wins_label.text() == "—W"
    assert not page.session_panel.isVisible()


def test_session_save_coalesces_latest_toggle_and_close_only_disables_session(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    preferences = dict(page._preferences)
    page.session_check.setChecked(True)
    first_save = next(call for call in calls if call["channel"] == "session_save")
    page.session_panel.close()
    assert not page.session_check.isChecked()
    assert page._preferences == preferences and page._session_queued
    finish(page, first_save, {"enabled": True})
    second_save = [call for call in calls if call["channel"] == "session_save"][-1]
    assert second_save["payload"] == {"action": "session_settings", "enabled": False}
    finish(page, second_save, {"enabled": False})
    assert not page._session_busy and page._session_saved is False
    assert not page.session_panel.isVisible()


def test_failed_session_save_restores_saved_choice_and_owner_mismatch_clears_record(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    page.session_check.setChecked(True)
    stats = next(call for call in calls if call["channel"] == "session_stats")
    finish(page, stats, session_result(owner="other-account"))
    assert page.session_panel.wins_label.text() == "—W"
    save = next(call for call in calls if call["channel"] == "session_save")
    finish(page, save, error="Disk unavailable")
    assert not page.session_check.isChecked() and not page.session_panel.isVisible()
    assert "not saved" in page.session_notice.text()


def test_session_setup_requires_explicit_confirmation_before_any_work(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    questions = []

    def decline(*arguments):
        questions.append(arguments)
        return QtWidgets.QMessageBox.No

    monkeypatch.setattr(QtWidgets.QMessageBox, "question", decline)
    page._setup_session()
    assert questions and "private Session stats" in questions[0][2]
    assert questions[0][-1] == QtWidgets.QMessageBox.No
    assert not calls


def test_session_setup_captures_owner_and_success_does_not_enable_without_choice(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *_args: QtWidgets.QMessageBox.Yes)
    page._setup_session()
    assert calls == [{"channel": "session_setup", "request": page._sequence,
                      "payload": {"action": "session_setup", "confirmed": True, "accountKey": "owned-account-session"}}]
    assert not page.session_setup_button.isEnabled()
    finish(page, calls[0], {"ready": True, "accountKey": "owned-account-session"})
    assert page.session_setup_button.isEnabled()
    assert "connection ready" in page.session_notice.text()
    assert not page.session_check.isChecked()


def test_session_setup_owner_change_during_confirmation_never_dispatches(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)

    def change_pairing(*_args):
        page._account_key = "new-account"
        return QtWidgets.QMessageBox.Yes

    monkeypatch.setattr(QtWidgets.QMessageBox, "question", change_pairing)
    page._setup_session()
    assert not calls and "pairing changed" in page.session_notice.text()


@pytest.mark.parametrize("result", [None, {"ready": True, "accountKey": "other-account"},
                                     {"ready": False, "accountKey": "owned-account-session"}])
def test_session_setup_invalid_result_never_reports_success(companion, monkeypatch, result):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *_args: QtWidgets.QMessageBox.Yes)
    page._setup_session()
    finish(page, calls[0], result)
    assert "could not be connected" in page.session_notice.text()
    assert page.session_setup_button.isEnabled()


def test_session_setup_old_account_completion_is_ignored_and_secrets_never_render(companion, monkeypatch):
    page, state, app = companion
    calls = capture_jobs(page, monkeypatch)
    monkeypatch.setattr(QtWidgets.QMessageBox, "question", lambda *_args: QtWidgets.QMessageBox.Yes)
    page._setup_session()
    pending = calls[0]
    finish(page, pending, error="private-test-token-and-raw-url")
    assert "private-test-token" not in page.session_notice.text()
    page._setup_session()
    pending = calls[-1]
    page._clear_library()
    page._account_key = "new-account"
    finish(page, pending, {"ready": True, "accountKey": "owned-account-session"})
    assert page.session_notice.isHidden()
    assert not page.session_setup_button.isEnabled()
