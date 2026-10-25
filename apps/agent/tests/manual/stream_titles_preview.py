"""Reproduce styled stream-title screenshots with sample data and no services.

Run from any directory with the desktop development Python. No paired account,
StreamService, provider client, OBS, runner or user settings are loaded.
"""
from pathlib import Path
import os
import sys

os.environ["QT_QPA_PLATFORM"] = "offscreen"
AGENT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AGENT))

from PySide6 import QtCore, QtGui, QtWidgets
from sc2tools_agent.ui.gui import _STYLE
from sc2tools_agent.ui.streams_page import build_streams_page


def capture():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    for name in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
        QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + name)
    app.setFont(QtGui.QFont("Segoe UI", 10))
    app.setStyleSheet(_STYLE)
    state = {"account_mode": "sc2tools", "metadata": {
        "title": "SC2 ladder | {mmr} MMR | {record}", "description": "Live StarCraft II games and practice."},
        "message": "Offline sample; automatic updates are off.", "youtube": {"connected": False},
        "platforms": {}, "catalog": {}, "title_automation": {"enabled": False,
            "template": "SC2 ladder | {mmr} MMR | {record}",
            "platforms": {"twitch": True, "kick": True, "youtube": False},
            "values": {"mmr": "5100", "league": "Master", "record": "3W–2L"},
            "message": "Preview uses sample statistics; no account requests."}}
    page = build_streams_page(None, provider=lambda: state, handler=lambda payload: state,
        QtCore=QtCore, QtWidgets=QtWidgets)
    destination = AGENT.parents[1] / "docs" / "screenshots"
    destination.mkdir(parents=True, exist_ok=True)
    for width, height, suffix in ((1120, 900, ""), (820, 600, "-small")):
        page.resize(width, height)
        page.show()
        app.processEvents()
        assert page.widget().width() <= page.viewport().width()
        assert page.grab().save(str(destination / ("desktop-stream-titles" + suffix + ".png")))
    page.timer.stop()
    page.hide()
    page.deleteLater()
    app.processEvents()


if __name__ == "__main__":
    capture()
