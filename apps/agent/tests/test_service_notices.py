from dataclasses import replace
from datetime import datetime, timedelta, timezone
import threading
from types import SimpleNamespace
from unittest.mock import Mock
from sc2tools_agent import __version__
from sc2tools_agent.runner import _announce_updated_version
from sc2tools_agent.state import AgentState
from sc2tools_agent.ui.tray_notices import TrayNotices
from sc2tools_agent.updater import SiteNotice, ReleaseInfo
from tests._gui_offscreen import run_gui_check


def notice(seconds=60, key="notice"):
    return SiteNotice("warning", "Uploads delayed. Nothing is lost.", "/help/desktop-app-sync-problems",
                      (datetime.now(timezone.utc)+timedelta(seconds=seconds)).isoformat(), key)


def test_tray_notice_toast_is_deduplicated_and_old_expiry_cannot_clear_new_notice():
    notify,refresh=Mock(),Mock()
    value=TrayNotices(notify=notify,refresh=refresh)
    one=notice();two=replace(one,hash="new",message="Maintenance is complete.")
    try:
        value.apply(one);value.apply(one)
        notify.assert_called_once_with(one.message,title="SC2 Tools service notice")
        value.apply(two);value.expire(one.hash)
        assert value.current==two and notify.call_count==2
        value.apply(None)
        assert value.current is None and value.timer is None
        value.apply(one)
        assert notify.call_count==2
    finally:value.stop()


def test_tray_visible_notice_expires_without_another_network_check():
    expired=threading.Event()
    value=TrayNotices(notify=Mock(),refresh=lambda:expired.set() if value.current is None else None)
    try:
        value.apply(notice(.15))
        assert value.current is not None
        assert expired.wait(5)
        assert value.current is None
    finally:value.stop()


def test_successful_version_check_updates_or_clears_notice_even_without_installer(tmp_path):
    cell=SimpleNamespace(gui=Mock(),tray=Mock())
    state=AgentState(last_run_version=__version__)
    cfg=SimpleNamespace(state_dir=tmp_path)
    release=ReleaseInfo("stable",False,__version__,__version__,None,"notes",None,None,notice())
    _announce_updated_version(cfg,state,cell,release)
    cell.gui.show_site_notice.assert_called_once_with(release.notice)
    cell.tray.on_site_notice.assert_called_once_with(release.notice)
    _announce_updated_version(cfg,state,cell,replace(release,notice=None))
    cell.gui.show_site_notice.assert_called_with(None)
    cell.tray.on_site_notice.assert_called_with(None)


def test_real_window_notice_is_plain_text_and_separate_from_update_and_transient(tmp_path):
    run_gui_check(tmp_path,r'''
from datetime import datetime,timedelta,timezone
from sc2tools_agent.updater import SiteNotice, ReleaseInfo
opened=[]
gui.webbrowser.open=lambda url,**kwargs:opened.append(url)
ui,win=make_window()
win.show()
future=(datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat()
notice=SiteNotice("critical","<b>Uploads delayed</b>","/help/desktop-app-sync-problems",future,"one")
ui.show_site_notice(notice)
release=ReleaseInfo("stable",True,"0.19.0","0.20.0",None,"Notes",None,None)
ui.show_update_state(release,"ready","")
ui.show_transient_notice("Capture queued.")
app.processEvents()
card=win._site_notice_card
assert card.isVisible() and card.text.text()=="<b>Uploads delayed</b>"
assert card.text.textFormat()==QtCore.Qt.PlainText
assert win._update_card.isVisible() and win._transient_notice.text()=="Capture queued."
card.details.click()
assert opened==["https://example.test/help/desktop-app-sync-problems"]
ui.show_site_notice(None);app.processEvents()
assert not card.isVisible() and win._update_card.isVisible()
expired=SiteNotice("warning","Finished",None,"2000-01-01T00:00:00Z","expired")
ui.show_site_notice(expired);app.processEvents()
assert not card.isVisible()
win.hide()
''')
