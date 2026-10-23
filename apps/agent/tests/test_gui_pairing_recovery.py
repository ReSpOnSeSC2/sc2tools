from tests._gui_offscreen import run_gui_check


def test_pairing_states_controls_expiry_and_confirmation(tmp_path):
    run_gui_check(tmp_path, """
from datetime import datetime, timedelta, timezone
from sc2tools_agent.pairing.flow import PairingUiState
opened=[]; clicked=[]
gui.webbrowser.open=lambda url, **kwargs: opened.append(url)
ui, win=make_window(initial_paired=False,
    on_pairing_retry=lambda: clicked.append("retry"),
    on_pairing_refresh=lambda: clicked.append("refresh"),
    on_link_again=lambda: clicked.append("link"))
win.show(); app.processEvents()
card=win._pairing_card
assert card.kind=="requesting" and card.spinner.isVisible()
assert card.message.text()=="Getting your code…" and not card.primary.isEnabled()
ui.on_pairing_state(PairingUiState("showing", "123456", datetime.now(timezone.utc)+timedelta(minutes=7, seconds=42)))
app.processEvents()
assert card.code_label.text()=="123456" and card.countdown.text().startswith("Expires in 7:")
card.primary.click()
assert opened[-1]=="https://example.test/devices?code=123456&src=agent"
card.copy.click(); assert app.clipboard().text()=="123456"
card.refresh.click(); assert clicked[-1]=="refresh"
ui.on_pairing_state(PairingUiState("unreachable",retry_in=30)); app.processEvents()
assert not card.code_label.isVisible() and card.primary.text()=="Retry now"
assert "we'll keep trying" in card.message.text()
card.primary.click(); assert clicked[-1]=="retry"
card.log.click(); assert win._stack.currentIndex()==2
ui.on_unlinked(); app.processEvents()
assert card.primary.text()=="Link again" and not win._paired
card.primary.click(); assert clicked[-1]=="link"
ui.on_pairing_state(PairingUiState("expired")); app.processEvents()
assert card.primary.text()=="Get a new code" and not card.code
ui.on_paired("u1"); app.processEvents()
assert card.isVisible() and card.message.text()=="Paired - syncing starts now"
assert card.collapse.isActive() and card.collapse.interval()==4000
card.collapse.timeout.emit(); assert not card.isVisible()
win.hide()
""")


def test_connection_banner_friendly_terminal_rows_and_help(tmp_path):
    run_gui_check(tmp_path, """
import time
from sc2tools_agent.errors import classify
from sc2tools_agent.uploader.queue import TerminalUploadError
opened=[]; retries=[]
gui.webbrowser.open=lambda url, **kwargs: opened.append(url)
ui,win=make_window(on_sync_retry=lambda:retries.append(True))
win.show(); app.processEvents()
ui.on_pending(312)
ui.on_connection_state("offline",time.time(),time.time()+30,312)
app.processEvents()
assert win._connection_banner.isVisible()
assert "Offline: 312 replays waiting" in win._connection_text.text()
win._connection_retry.click(); assert retries==[True]
win._connection_help.click(); assert opened[-1].endswith("desktop-app-sync-problems?src=agent#offline")
error=classify(TerminalUploadError("game_payload_too_large: detail"))
ui.on_upload_failed("game.SC2Replay",error); app.processEvents()
item=win._recent_table.item(0,2)
assert "too much data" in item.text() and item.toolTip()==error.detail
buttons=win._recent_table.cellWidget(0,3).findChildren(QtWidgets.QPushButton)
next(button for button in buttons if button.text()=="Copy details").click()
assert app.clipboard().text()==error.detail
next(button for button in buttons if button.text()=="Help").click()
assert opened[-1].endswith("#rejected")
ui.on_connection_state("online",time.time(),0,0); app.processEvents()
assert not win._connection_banner.isVisible()
win.hide()
""")
