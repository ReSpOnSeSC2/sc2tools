"""One local, time-bounded confirmation; no OBS calls on the Qt thread."""
from __future__ import annotations

import time


def show_obs_confirmation(request, *, parent, QtCore, QtWidgets):
    remaining = request["expiresAt"] / 1000 - time.time()
    if request["done"].is_set() or remaining <= 0:
        request["done"].set()
        return
    dialog = QtWidgets.QMessageBox(parent)
    dialog.setWindowTitle("Website request to OBS")
    dialog.setTextFormat(QtCore.Qt.PlainText)
    dialog.setText(f"Add {request['label']} to scene {request['scene']}?")
    dialog.setInformativeText("This adds a Browser Source to the current program scene. It may appear on your live stream. Existing sources stay in place.")
    dialog.setStandardButtons(QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.Cancel)
    dialog.button(QtWidgets.QMessageBox.Yes).setText("Add source")
    dialog.setDefaultButton(QtWidgets.QMessageBox.Cancel)
    dialog.setEscapeButton(QtWidgets.QMessageBox.Cancel)
    timer = QtCore.QTimer(dialog)
    timer.setSingleShot(True)
    timer.timeout.connect(dialog.reject)
    timer.start(max(1, int(remaining * 1000)))
    accepted = dialog.exec() == QtWidgets.QMessageBox.Yes
    request["accepted"] = accepted and not request["done"].is_set() and time.time() < request["expiresAt"] / 1000
    request["done"].set()
