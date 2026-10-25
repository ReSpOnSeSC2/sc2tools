"""Synthetic, offscreen native evidence. Never imports or connects an OBS client."""
import os
from pathlib import Path
import threading
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6 import QtCore, QtGui, QtWidgets
from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow, _ObsBuildDialog, _STYLE
from sc2tools_agent.ui.obs_confirmation import show_obs_confirmation

app = QtWidgets.QApplication([])
for name in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
    QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + name)
app.setFont(QtGui.QFont("Segoe UI", 10))
app.setStyleSheet(_STYLE)
output = Path(__file__).resolve().parents[4] / "docs" / "handoff" / "screenshots"
output.mkdir(parents=True, exist_ok=True)
dialog = _ObsBuildDialog(parent=None, QtWidgets=QtWidgets, webcams=["Synthetic camera"], games=["StarCraft II"], update_existing=True)
for height in (700, 480):
    dialog.resize(560, height)
    dialog.show()
    app.processEvents()
    buttons = dialog.findChild(QtWidgets.QDialogButtonBox)
    assert buttons.button(QtWidgets.QDialogButtonBox.Cancel).isDefault()
    assert buttons.geometry().bottom() < dialog.height()
    assert dialog.grab().save(str(output / f"obs-builder-native-{height}.png"))
dialog.close()
request = {"label": "Opponent identity", "scene": "SC2 Tools — In Game", "expiresAt": (time.time()+5)*1000, "done": threading.Event(), "accepted": False}
def capture():
    box = next(widget for widget in app.topLevelWidgets() if isinstance(widget, QtWidgets.QMessageBox) and widget.isVisible())
    assert box.defaultButton() == box.button(QtWidgets.QMessageBox.Cancel)
    assert box.grab().save(str(output / "obs-source-native-confirm.png"))
    box.button(QtWidgets.QMessageBox.Cancel).click()
QtCore.QTimer.singleShot(200, capture)
show_obs_confirmation(request, parent=None, QtCore=QtCore, QtWidgets=QtWidgets)
assert request["done"].is_set() and request["accepted"] is False
ui = GuiUI(version="synthetic", dashboard_url="https://example.test/app", pairing_url="https://example.test/devices",
           log_dir=output, log_file=output / "synthetic-absent.log", api_base="https://api.example.test",
           replay_folders=[], initial_paused=False, initial_paired=True, initial_user_id="synthetic",
           initial_settings=SettingsPayload(), on_pause=lambda _: None, on_resync=lambda: None,
           on_choose_folder=lambda _: None, on_check_updates=lambda: None, on_save_settings=lambda _: None,
           on_quit=lambda: None, window_animations=False)
ui._signals = _GuiSignals()
win = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
win._log_timer.stop()
win._set_window_size("Standard")
win._go_to_page("settings")
win.resize(480, 680)
win.show()
app.processEvents()
scroll = win._stack.currentWidget()
scroll.ensureWidgetVisible(win._obs_website_add_check)
app.processEvents()
assert scroll.horizontalScrollBar().maximum() == 0
assert not win._obs_website_add_check.isChecked()
assert win.grab().save(str(output / "obs-source-native-settings-480.png"))
win._companion_page.shutdown()
win._race_effects.shutdown()
win._really_quit = True
win.close()
print("4 offscreen native captures; default Cancel, default-off opt-in and minimum width verified")
