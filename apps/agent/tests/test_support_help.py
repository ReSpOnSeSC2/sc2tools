"""Actual synthetic Qt support surfaces and headless actions; no probes."""
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from sc2tools_agent.support_diagnostics import DiagnosticRow, DiagnosticSnapshot, ROW_IDS, SupportInfo, diagnostic_bytes
from sc2tools_agent.ui.support_actions import copy_headless, support_mailto
from tests._gui_offscreen import run_gui_check


GUI_SUPPORT = r'''
from sc2tools_agent.support_diagnostics import DiagnosticRow, DiagnosticSnapshot, ROW_IDS, SupportInfo
from sc2tools_agent.support_probes import FolderSummary
from sc2tools_agent.support_runtime import PreviewEntry, SupportResult
class Support:
    def __init__(self): self.nonce=0; self.busy=False; self.calls=[]; self.pending=None
    def is_current(self, nonce): return nonce == self.nonce
    def begin(self, kind, delivered):
        if self.busy: return None
        self.nonce += 1; self.busy=True; self.pending=(kind, delivered, self.nonce); self.calls.append(kind)
        return self.nonce
    def run_check(self, delivered): return self.begin("check", delivered)
    def copy_info(self, delivered): return self.begin("copy", delivered)
    def prepare_bundle(self, delivered): return self.begin("review", delivered)
    def cancel(self): self.nonce += 1
    invalidate=cancel
    def settle(self, *, entries=(), rows=None):
        kind, delivered, nonce=self.pending; self.busy=False
        snapshot=DiagnosticSnapshot(SupportInfo(version="0.24.8", user_hash8="1234abcd", device_suffix6="abcdef"),
            tuple(rows or [DiagnosticRow(key,"pass","ok") for key in ROW_IDS]))
        result=SupportResult(nonce,kind,snapshot,(FolderSummary(1,2,"2026-11-02T12:00:00Z",True,True),),entries)
        delivered(result)
        return result
    def save_reviewed(self, nonce, destination, delivered):
        if self.busy or not self.is_current(nonce): return None
        self.calls.append(("save",nonce,destination)); return nonce
support=Support()
ui,win=make_window(window_page="help")
ui.set_support_service(support)
page=win._help_page
page.poll()
win.show(); app.processEvents()
'''


def test_native_help_has_nine_rows_no_automatic_probe_and_cancellation_retains_busy(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
assert win._PAGE_KEYS[win._stack.currentIndex()] == "help"
assert win._stack.count() == 7 and len(page.rows) == 9 and support.calls == []
page.run_button.click()
assert support.calls == ["check"] and support.busy
page.cancel_button.click()
assert "Cancelling" in page.status.text() and not page.run_button.isEnabled()
assert not page.copy_button.isEnabled() and not page.bundle_button.isEnabled()
page.start("check")
assert support.calls == ["check"]
support.settle(); app.processEvents(); page.poll()
assert page.run_button.isEnabled() and "Cancelled" in page.status.text()
assert all("Unavailable" in label.text() for label,action in page.rows.values())
win.hide()
''')


def test_queued_copy_after_owner_retirement_never_changes_clipboard_or_rows(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
app.clipboard().setText("unchanged synthetic clipboard")
page.copy_button.click()
old=support.settle()  # Signal is explicitly queued, even from this GUI thread.
support.invalidate()
app.processEvents(); page.poll()
assert app.clipboard().text() == "unchanged synthetic clipboard"
assert page.result is None and page.files.topLevelItemCount() == 0
assert all("Unavailable" in label.text() for label,action in page.rows.values())
assert not support.is_current(old.run_nonce)
win.hide()
''')


def test_activity_copy_and_health_copy_use_safe_current_text_without_raw_log_read(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
ui._log_file=base / "must-not-read-private-log"
win._go_to_page("log")
win._activity_log.support_copy_button.click()
support.settle(); app.processEvents()
copied=app.clipboard().text()
assert copied.startswith("SC2 Tools support diagnostics v1\n")
assert "1234abcd" in copied and "abcdef" in copied and "must-not-read" not in copied
assert "Support info copied" in page.status.text()
win._copy_status_details()
assert support.calls == ["copy","copy"]
support.settle(); app.processEvents()
assert app.clipboard().text() == copied
for width in (480,900):
    win.resize(width,700); app.processEvents()
    win._activity_log._reflow_controls()
    app.processEvents()
    button=win._activity_log.support_copy_button
    assert button.parentWidget().rect().contains(button.geometry())
win.hide()
''')


def test_help_preview_file_list_and_save_revalidate_public_review_nonce(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
entries=tuple(PreviewEntry(name,10,"0"*64,0,False,"ok") for name in ("diagnostics.txt","state-summary.json","logs/agent-0.log"))
page.bundle_button.click(); support.settle(entries=entries); app.processEvents(); page.poll()
assert [page.files.topLevelItem(i).text(0) for i in range(page.files.topLevelItemCount())] == [entry.alias for entry in entries]
assert page.save_button.isEnabled()
QtWidgets.QFileDialog.getSaveFileName=lambda *args,**kwargs:(str(base/"support.zip"),"ZIP")
page.save_button.click()
saved=[call for call in support.calls if isinstance(call,tuple)]
assert len(saved)==1 and saved[0][1]==page.run_nonce
support.invalidate(); page.save()
assert len([call for call in support.calls if isinstance(call,tuple)])==1
assert page.files.topLevelItemCount()==0
win.hide()
''')


def test_help_renders_folder_sample_truth_and_fixes_and_clears_when_leaving(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
rows=[DiagnosticRow(key,"pass","ok") for key in ROW_IDS]
rows[5]=DiagnosticRow("profile","fail","signed_out","link_again")
linked=[]; ui._on_link_again=lambda:linked.append(True)
page.run_button.click(); support.settle(rows=rows); app.processEvents()
assert "Folder 1: 2 replays" in page.folder_details.text() and "2026-11-02T12:00:00Z" in page.folder_details.text()
assert page.rows["profile"][1].text()=="Link again"
page.rows["profile"][1].click(); assert linked==[True]
win._go_to_page("settings")
assert page.result is None and all("Unavailable" in label.text() for label,action in page.rows.values())
win.hide()
''')


def test_saved_completion_hides_old_row_fixes_and_late_callback_is_safe(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
rows=[DiagnosticRow(key,"pass","ok") for key in ROW_IDS]
rows[5]=DiagnosticRow("profile","fail","signed_out","link_again")
linked=[]; ui._on_link_again=lambda:linked.append(True)
page.run_button.click(); support.settle(rows=rows); app.processEvents()
assert page.rows["profile"][1].isVisible()
entries=tuple(PreviewEntry(name,10,"0"*64,0,False,"ok") for name in ("diagnostics.txt","state-summary.json"))
page.bundle_button.click(); support.settle(entries=entries,rows=rows); app.processEvents(); page.poll()
QtWidgets.QFileDialog.getSaveFileName=lambda *args,**kwargs:(str(base/"support.zip"),"ZIP")
def saved(nonce,destination,delivered):
    support.calls.append(("save",nonce,destination))
    delivered(SupportResult(nonce,"saved"))
    return nonce
support.save_reviewed=saved
page.save_button.click(); app.processEvents()
assert page.result.kind=="saved" and page.result.snapshot is None
assert all(not action.isVisible() for label,action in page.rows.values())
page.fix("profile")  # A previously queued old-row callback must also be safe.
assert linked==[] and page.result is None
win.hide()
''')


def test_modal_save_after_owner_retirement_never_dereferences_cleared_review_or_admits_write(tmp_path):
    run_gui_check(tmp_path, GUI_SUPPORT + r'''
entries=tuple(PreviewEntry(name,10,"0"*64,0,False,"ok") for name in ("diagnostics.txt","state-summary.json"))
page.bundle_button.click(); support.settle(entries=entries); app.processEvents(); page.poll()
assert page.result.kind=="review"
def choose_after_retirement(*args,**kwargs):
    support.invalidate(); page.poll()
    assert page.result is None
    return str(base/"must-not-write.zip"),"ZIP"
QtWidgets.QFileDialog.getSaveFileName=choose_after_retirement
page.save()
assert not any(isinstance(call,tuple) and call[0]=="save" for call in support.calls)
assert page.result is None and page.files.topLevelItemCount()==0
assert "review changed" in page.status.text().lower()
win.hide()
''')


def snapshot():
    return DiagnosticSnapshot(SupportInfo(version="0.24.8", user_hash8="1234abcd"), tuple(DiagnosticRow(key) for key in ROW_IDS))


def test_mailto_uses_only_verified_contact_and_approved_text():
    parsed = urlsplit(support_mailto(snapshot()))
    assert parsed.scheme == "mailto" and parsed.path == "responsecoaching@gmail.com"
    body = parse_qs(parsed.query)["body"][0]
    assert body == diagnostic_bytes(snapshot()).decode("utf-8")
    assert "1234abcd" in body and "token" not in body and len(support_mailto(snapshot())) <= 16000


def test_headless_copy_uses_current_guard_and_reports_unsupported_without_dumping(monkeypatch, capsys):
    published = []
    assert copy_headless(snapshot(), is_current=lambda: False, publish=lambda *_args: published.append(True)) is False
    assert published == []
    assert copy_headless(snapshot(), is_current=lambda: True, publish=lambda text, guard: published.append(text) or True)
    assert published == [diagnostic_bytes(snapshot()).decode("utf-8")]
    assert copy_headless(snapshot(), is_current=lambda: True, publish=lambda *_args: False) is False
    assert capsys.readouterr().out == ""


def test_tray_support_routes_gui_callbacks_and_headless_copy_honestly(tmp_path, monkeypatch):
    from sc2tools_agent.ui.tray import TrayUI
    from sc2tools_agent.ui import support_actions
    from sc2tools_agent.support_runtime import SupportResult
    tray = TrayUI(dashboard_url="https://example.test/app", log_dir=tmp_path, on_build_checkin=lambda: None)
    notices, actions = [], []
    tray.show_notice = lambda text, **_kwargs: notices.append(text)
    service = type("Service", (), {"busy": False, "is_current": lambda _self, nonce: nonce == 1,
        "copy_info": lambda _self, delivered: delivered(SupportResult(1, "copy", snapshot())) or 1})()
    tray.set_support_service(service, on_help=lambda: actions.append("help"), on_copy=lambda: actions.append("copy"))
    tray._support_help_clicked(); tray._support_copy_clicked()
    assert actions == ["help", "copy"]
    tray.set_support_service(service)
    class Menu:
        SEPARATOR = object()
        def __init__(self, *items): self.items = items
    pystray = SimpleNamespace(Menu=Menu, MenuItem=lambda label, action, **options: SimpleNamespace(label=label, action=action, options=options))
    labels = [item.label for item in tray._build_menu(pystray).items if item is not Menu.SEPARATOR]
    assert "Help and troubleshooting" in labels and "Copy support info" in labels
    assert labels[labels.index("Open dashboard") + 1:labels.index("Open dashboard") + 4] == [
        "Build check-in…", "Help and troubleshooting", "Copy support info"]
    monkeypatch.setattr(support_actions, "copy_headless", lambda *_args, **_kwargs: False)
    tray._support_copy_clicked()
    assert "Clipboard unavailable" in notices[-1] and "copied" not in notices[-1].lower()
    service.busy = True
    assert tray._support_enabled(None) is False
