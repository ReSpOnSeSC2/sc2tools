from tests._gui_offscreen import run_gui_check


def test_pairing_states_controls_expiry_and_confirmation(tmp_path):
    run_gui_check(tmp_path, """
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock
from sc2tools_agent import runner
from sc2tools_agent.health import HealthMonitor
from sc2tools_agent.pairing.flow import PairingUiState
opened=[]; clicked=[]
gui.webbrowser.open=lambda url, **kwargs: opened.append(url)
ui, win=make_window(initial_paired=False,
    on_pairing_retry=lambda: clicked.append("retry"),
    on_pairing_refresh=lambda: clicked.append("refresh"),
    on_link_again=lambda: clicked.append("link"))
mux=runner._Multiplexer(Mock(),None,ui,health=HealthMonitor(schedule=lambda delay,callback:callback()))
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
mux.on_unlinked(); app.processEvents()
assert card.primary.text()=="Link again" and not win._paired
pairing=next(line for line in win._health_view.lines if line.row.id=="pairing")
assert pairing.sentence.text()=="This PC was unlinked from your account."
clicked.clear()
pairing.action_button.click(); assert clicked==["link"]  # Link PC takes the pairing card's step
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
from unittest.mock import Mock
from sc2tools_agent import runner
from sc2tools_agent.errors import classify
from sc2tools_agent.health import HealthMonitor
from sc2tools_agent.uploader.queue import TerminalUploadError
opened=[]; retries=[]
gui.webbrowser.open=lambda url, **kwargs: opened.append(url)
ui,win=make_window(replay_folders=[base/"2-S2-1-42"],on_sync_retry=lambda:retries.append(True))
win.show(); app.processEvents()
mux=runner._Multiplexer(Mock(),None,ui,health=HealthMonitor(schedule=lambda delay,callback:callback()))
mux.on_pending(312)
mux.on_connection_state("offline",time.time(),time.time()+30,312)
app.processEvents()
assert win._health_view.headline.text()=="1 thing needs attention"
cloud=win._health_view.lines[0]
assert cloud.sentence.text()=="Can't reach sc2tools.com, so 312 replays are waiting."
cloud.action_button.click(); assert retries==[True]
cloud.help_button.click(); assert opened[-1].endswith("desktop-app-sync-problems?src=agent#offline")
error=classify(TerminalUploadError("game_payload_too_large: detail"))
ui.on_upload_failed("game.SC2Replay",error); app.processEvents()
model=win._recent_table.model()
assert "too much data" in model.data(model.index(0,7))
assert model.data(model.index(0,7),QtCore.Qt.ToolTipRole)==error.detail
menu=win._recent_widget.menu_for(model.visible[0])
actions={action.text():action for action in menu.actions()}
actions["Copy error"].trigger()
assert app.clipboard().text()==error.detail
actions["Help"].trigger()
assert opened[-1].endswith("#rejected")
ui.on_connection_state("online",time.time(),0,0); app.processEvents()
assert not hasattr(win,"_connection_banner") and win._connection_kind=="online"
ui.on_upload_success("uploaded.SC2Replay"); app.processEvents()
assert model.data(model.index(0,7))=="Uploaded"
ui.on_upload_failed("legacy.SC2Replay","Plain error"); app.processEvents()
assert model.data(model.index(0,7))=="Plain error"
win.hide()
""")
