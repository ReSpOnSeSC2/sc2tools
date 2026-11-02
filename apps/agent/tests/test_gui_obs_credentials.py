"""Real offscreen widgets exercise credential intent and queued retirement."""
from tests._gui_offscreen import run_gui_check


def test_saved_password_is_never_prefilled_and_user_edits_capture_explicit_revision(tmp_path):
    run_gui_check(tmp_path, r'''
metadata = [7, "available", False]
def persist(payload):
    saved.append(payload)
    if payload.obs_password_intent != "keep":
        metadata[0] += 1
        metadata[1] = "cleared" if payload.obs_password_intent == "clear" else "available"
ui, win = make_window(initial_settings=SettingsPayload(obs_password="saved-private-password"),
    obs_credential_provider=lambda: tuple(metadata), on_save_settings=persist)
assert win._obs_password_input.text() == ""
assert all("saved-private-password" not in field.text() for field in win.findChildren(QtWidgets.QLineEdit))
assert "Saved securely" in win._obs_credential_status.text()
# Programmatic population cannot manufacture a user SET intent.
win._obs_password_input.setText("programmatic-private")
win._click_save_settings(); wait_saved(win)
assert saved[-1].obs_password is None and saved[-1].obs_password_intent == "keep"
assert saved[-1].obs_credential_revision == 7
assert win._obs_password_input.text() == ""

QtTest.QTest.keyClicks(win._obs_password_input, "new-private")
assert win._obs_password_operation == "set" and win._obs_edit_revision == 7
metadata[0] = 8  # Another current writer committed while this form was dirty.
win._click_save_settings(); app.processEvents()
assert len(saved) == 1 and not win._settings_save_pending
assert win._obs_password_input.text() == "new-private"
# An explicit new edit admits a new candidate; failure did not silently bless it.
win._obs_password_input.selectAll()
QtTest.QTest.keyClicks(win._obs_password_input, "replacement-private")
win._click_save_settings(); wait_saved(win)
assert saved[-1].obs_password_intent == "set"
assert saved[-1].obs_password == "replacement-private"
assert saved[-1].obs_credential_revision == 8
assert win._obs_password_input.text() == "" and win._obs_password_operation == "keep"
assert metadata[0] == 9
win._obs_clear_password.setChecked(True)
win._click_save_settings(); wait_saved(win)
assert saved[-1].obs_password_intent == "clear" and saved[-1].obs_password is None
assert saved[-1].obs_credential_revision == 9
assert metadata == [10, "cleared", False]
assert not win._obs_clear_password.isChecked() and "No saved password" in win._obs_credential_status.text()
win._click_save_settings(); wait_saved(win)
assert saved[-1].obs_password_intent == "keep" and saved[-1].obs_password is None
win.deleteLater(); app.processEvents()
''')


def test_held_test_has_one_worker_until_settlement_and_drops_retired_slot_result(tmp_path):
    run_gui_check(tmp_path, r'''
import threading
metadata = [2, "available", False]
entered, release = threading.Event(), threading.Event()
calls = []
def probe(host, port, password, operation, revision):
    calls.append((host, port, password, operation, revision))
    entered.set()
    assert release.wait(5)
    return {"ok": True, "message": "OLD APPROVED INVENTORY", "scenes": ["OLD SCENE"], "webcams": ["OLD CAMERA"]}
ui, win = make_window(obs_credential_provider=lambda: tuple(metadata), on_obs_probe_candidate=probe)
try:
    win._click_obs_test()
    assert entered.wait(5)
    first = win._obs_job
    assert first is not None and not win._obs_test_btn.isEnabled()
    metadata[0] = 3
    win._click_obs_test()
    assert win._obs_job is first and len(calls) == 1
    assert calls[0][2:] == (None, "keep", 2)
finally:
    release.set()
deadline = QtCore.QDeadlineTimer(5000)
while win._obs_job is not None and not deadline.hasExpired():
    QtTest.QTest.qWait(10)
assert win._obs_job is None and win._obs_test_btn.isEnabled()
assert not win._obs_build_btn.isEnabled()
assert "OLD APPROVED" not in win._obs_status.text()
assert win._obs_sources == {"webcam": [], "game": []}
assert all(combo.findData("OLD SCENE") == -1 for combo in win._obs_scene_combos.values())
assert saved == []
win.deleteLater(); app.processEvents()
''')


def test_failed_save_preserves_dirty_intent_without_copying_raw_exception_to_ui(tmp_path):
    run_gui_check(tmp_path, r'''
def fail(payload):
    saved.append(payload)
    raise RuntimeError("raw-private-token C:/private/person/agent.json")
ui, win = make_window(obs_credential_provider=lambda: (4, "unreadable", False), on_save_settings=fail)
assert "unavailable" in win._obs_credential_status.text()
QtTest.QTest.keyClicks(win._obs_password_input, "candidate-private")
win._click_save_settings(); wait_saved(win)
assert saved[-1].obs_password_intent == "set" and saved[-1].obs_credential_revision == 4
assert win._obs_password_operation == "set" and win._obs_password_input.text() == "candidate-private"
all_labels = " ".join(label.text() for label in win.findChildren(QtWidgets.QLabel))
assert "raw-private-token" not in all_labels and "C:/private" not in all_labels
assert "settings write did not finish" in all_labels
win.deleteLater(); app.processEvents()
''')


def test_modal_build_rechecks_original_credential_and_owner_scope_after_dialog(tmp_path):
    run_gui_check(tmp_path, r'''
metadata = [4, "available", False]
epoch = [object()]
calls = []
ui, win = make_window(obs_credential_provider=lambda: tuple(metadata), auth_epoch_guard=lambda value: value is epoch[0],
    initial_auth_epoch=epoch[0], on_obs_build=lambda request: calls.append(request))
class Dialog:
    def __init__(self, **kwargs): pass
    def exec(self):
        metadata[0] = 5
        epoch[0] = object()
        app.processEvents()
        return True
    def webcam(self): raise AssertionError("retired dialog must not supply a candidate")
gui._ObsBuildDialog = Dialog
win._click_obs_build()
assert calls == [] and win._obs_job is None
assert "Settings changed" in win._obs_status.text()
win.deleteLater(); app.processEvents()
''')


def test_queued_old_auth_and_import_events_cannot_overwrite_new_pairing(tmp_path):
    run_gui_check(tmp_path, r'''
from sc2tools_agent.pairing.flow import PairingUiState
epoch = [object()]
old = epoch[0]
ui, win = make_window(auth_epoch_guard=lambda value: value is epoch[0], initial_auth_epoch=old)
ui.on_unlinked_current(old)
ui.on_import_progress_current({"phase": "OLD IMPORT"}, old)
ui.on_pairing_state(PairingUiState("showing", code="123456", owner_epoch=old))
epoch[0] = object()
new = epoch[0]
app.processEvents()  # Deliver old queued events before the new account paints.
assert win._paired is True and win._user_id == "u1"
assert win._import_progress == {"phase": "idle"}
assert win._pairing_code_label.text() != "123456"
ui.on_paired_current("new-owner", new)
ui.on_import_progress_current({"phase": "current"}, new)
app.processEvents()
assert win._paired is True and win._user_id == "new-owner"
assert win._visible_auth_epoch is new and win._import_progress == {"phase": "current"}
assert win._pairing_code_label.text() != "123456"
ui.on_unlinked()  # Configured production UI rejects unscoped legacy delivery.
ui.on_paired("legacy-owner")
ui.on_import_progress({"phase": "legacy"})
app.processEvents()
assert win._paired is True and win._user_id == "new-owner"
assert win._import_progress == {"phase": "current"}
win.deleteLater(); app.processEvents()
''')


def test_worker_launch_failure_retries_only_when_proven_unstarted(tmp_path):
    run_gui_check(tmp_path, r'''
import threading
entered, release = threading.Event(), threading.Event()
calls = []
def probe(*args):
    calls.append(args)
    entered.set()
    assert release.wait(5)
    return {"ok": True, "message": "Current connection", "scenes": []}
ui, win = make_window(obs_credential_provider=lambda: (1, "cleared", False), on_obs_probe_candidate=probe)
real_start = threading.Thread.start
def never_started(self):
    raise RuntimeError("private startup detail")
threading.Thread.start = never_started
try:
    win._click_obs_test()
finally:
    threading.Thread.start = real_start
assert win._obs_job is None and win._obs_test_btn.isEnabled()
assert calls == [] and "private startup detail" not in win._obs_status.text()
# A native worker that entered remains reserved even if a wrapper raises after start.
def started_then_raised(self):
    real_start(self)
    assert entered.wait(5)
    raise RuntimeError("private started detail")
threading.Thread.start = started_then_raised
try:
    win._click_obs_test()
    first = win._obs_job
    assert first is not None and len(calls) == 1
    win._click_obs_test()
    assert win._obs_job is first and len(calls) == 1
    assert not win._obs_test_btn.isEnabled()
finally:
    threading.Thread.start = real_start
    release.set()
deadline = QtCore.QDeadlineTimer(5000)
while win._obs_job is not None and not deadline.hasExpired():
    QtTest.QTest.qWait(10)
assert win._obs_job is None and win._obs_test_btn.isEnabled()
assert win._obs_status.text() == "Current connection"
win.deleteLater(); app.processEvents()
''')


def test_malformed_private_probe_result_settles_with_fixed_error_and_allows_retry(tmp_path):
    run_gui_check(tmp_path, r'''
calls = []
def probe(*args):
    calls.append(args)
    return 42 if len(calls) == 1 else {"ok": True, "message": "Retry worked", "scenes": []}
ui, win = make_window(obs_credential_provider=lambda: (1, "cleared", False), on_obs_probe_candidate=probe)
def settle():
    deadline = QtCore.QDeadlineTimer(5000)
    while win._obs_job is not None and not deadline.hasExpired():
        QtTest.QTest.qWait(10)
    assert win._obs_job is None
win._click_obs_test(); settle()
assert len(calls) == 1 and win._obs_test_btn.isEnabled() and not win._obs_build_btn.isEnabled()
assert "could not finish" in win._obs_status.text()
win._click_obs_test(); settle()
assert len(calls) == 2 and win._obs_status.text() == "Retry worked"
win.deleteLater(); app.processEvents()
''')


def test_new_auth_epoch_discards_already_painted_import_cache_without_new_import_event(tmp_path):
    run_gui_check(tmp_path, r'''
epoch = [object()]
ui, win = make_window(recent_games_enabled=True, auth_epoch_guard=lambda value: value is epoch[0], initial_auth_epoch=epoch[0])
win.show(); app.processEvents()
old = {"phase": "importing", "remaining": 91, "total": 100, "completed": 9, "errors": 0}
ui.on_import_progress_current(old, epoch[0]); app.processEvents(); win._paint_stats()
assert win._stat_queued["value"].text() == "91"
assert not win._game_dashboard.import_card.isHidden()
# A same-epoch reconnect must preserve a valid delivered import snapshot.
ui.on_paired_current("u1", epoch[0]); app.processEvents(); win._paint_stats()
assert win._import_progress == old and win._stat_queued["value"].text() == "91"
# Same user, new lifetime: no new import event is needed to remove A's cache.
epoch[0] = object()
ui.on_paired_current("u1", epoch[0]); app.processEvents(); win._paint_stats()
assert win._import_progress == {"phase": "idle"}
assert win._stat_queued["value"].text() == "0"
assert win._game_dashboard.import_card.isHidden()
assert win._paired and win._user_id == "u1"
# Accepted unlink retires an already delivered cache as well.
ui.on_import_progress_current(old, epoch[0]); app.processEvents(); win._paint_stats()
assert win._stat_queued["value"].text() == "91"
epoch[0] = object()
ui.on_unlinked_current(epoch[0]); app.processEvents(); win._paint_stats()
assert win._import_progress == {"phase": "idle"}
assert win._stat_queued["value"].text() == "0"
assert win._game_dashboard.import_card.isHidden()
# A current socket can report B's work before the paired event reaches Qt.
epoch[0] = object()
current = {"phase": "importing", "remaining": 12, "total": 20, "completed": 8}
ui.on_import_progress_current(current, epoch[0]); app.processEvents(); win._paint_stats()
assert win._stat_queued["value"].text() == "12" and win._import_progress == current
ui.on_paired_current("new-owner", epoch[0]); app.processEvents(); win._paint_stats()
assert win._paired and win._user_id == "new-owner"
assert win._stat_queued["value"].text() == "12" and win._import_progress == current
assert not win._game_dashboard.import_card.isHidden()
win.deleteLater(); app.processEvents()
''')
