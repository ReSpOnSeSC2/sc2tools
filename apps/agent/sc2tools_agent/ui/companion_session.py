"""Small, independently pinned view of the owner's authoritative session."""

from __future__ import annotations

from datetime import datetime
import math
import re
import time

from . import theme


SESSION_FRESH_SECONDS = 90
_STYLE = f"""
QWidget#sessionPanel {{ background: {theme.BG}; border: 1px solid {theme.ACCENT}; border-radius: 7px; }}
QWidget#sessionPanel QLabel {{ background: transparent; border: none; color: {theme.TEXT}; }}
QWidget#sessionPanel QLabel#sessionTitle {{ color: {theme.TEXT_MUTED}; font-size: 11px; }}
QWidget#sessionPanel QLabel#sessionWins {{ color: {theme.SUCCESS}; }}
QWidget#sessionPanel QLabel#sessionLosses {{ color: {theme.DANGER}; }}
QWidget#sessionPanel QLabel#sessionElapsed {{ color: {theme.ACCENT_CYAN}; font-size: 13px; }}
QWidget#sessionPanel QLabel#sessionRating, QWidget#sessionPanel QLabel#sessionRegion {{ color: {theme.TEXT_MUTED}; font-size: 11px; }}
"""


def _number(value):
    if type(value) not in {int, float}:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _count(value):
    return type(value) is int and 0 <= value <= 2 ** 53 - 1


def _started_at(value):
    if not isinstance(value, str) or len(value) > 100:
        return None
    try:
        started = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return started.timestamp() if started.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def format_session_elapsed(seconds):
    if not _number(seconds) or seconds < 0:
        return "—"
    hours, remainder = divmod(int(seconds), 3600)
    minutes, remainder = divmod(remainder, 60)
    return f"{hours}h {minutes:02d}m" if hours else f"{minutes}m {remainder:02d}s"


def session_presentation(snapshot, *, now=None):
    """Format fresh owner-fenced data without inventing a record or start time."""
    result = {"available": False, "wins": None, "losses": None, "winsText": "—W", "lossesText": "—L",
              "elapsedText": "—", "region": None, "mmr": None, "ratingText": "MMR —",
              "regionText": "Rating region —", "description": "Session stats unavailable."}
    current = time.time() if now is None else now
    if not isinstance(snapshot, dict) or not _number(current):
        return result
    if snapshot.get("paired") is not True:
        return {**result, "description": "Pair this agent to load your session record."}
    owner = snapshot.get("accountKey")
    received = snapshot.get("receivedAt")
    if not isinstance(owner, str) or not owner.strip() or snapshot.get("source") != "overlay-session":
        return result
    if not _number(received) or not -5 <= current - received <= SESSION_FRESH_SECONDS:
        return {**result, "description": "Session stats are stale. Reconnect to refresh."}
    session = snapshot.get("session")
    if not isinstance(session, dict):
        return {**result, "description": "Waiting for your current session record."}
    wins, losses, games = session.get("wins"), session.get("losses"), session.get("games")
    if not all(_count(value) for value in (wins, losses, games)) or games < wins + losses:
        return result
    started = _started_at(session.get("sessionStartedAt"))
    elapsed = format_session_elapsed(current - started) if started is not None else "—"
    region = session.get("region")
    region = region.strip().upper() if isinstance(region, str) else ""
    region = region if re.fullmatch(r"[A-Z0-9_-]{1,12}", region) else None
    rating = snapshot.get("ownRating")
    mmr = None
    if (isinstance(rating, dict) and rating.get("source") == "overlay-session"
            and rating.get("status") == "latest-known"):
        candidate = rating.get("mmr")
        if type(candidate) is int and 0 <= candidate <= 20_000:
            mmr = candidate
    rating_text = f"{mmr} MMR · latest" if mmr is not None else "MMR —"
    region_text = "Rating region " + (region or "—")
    description = f"Session: {wins} wins, {losses} losses. "
    description += "Elapsed " + elapsed + "." if elapsed != "—" else "Session elapsed time unavailable."
    if region:
        description += " Rating region " + region + "."
    if mmr is not None:
        description += f" Your latest-known MMR is {mmr}."
    description += " Active server is unavailable from the SC2 local API."
    return {"available": True, "wins": wins, "losses": losses, "winsText": f"{wins}W", "lossesText": f"{losses}L",
            "elapsedText": elapsed, "region": region, "mmr": mmr, "ratingText": rating_text,
            "regionText": region_text, "description": description}


def build_companion_session(parent=None, *, QtCore, QtGui, QtWidgets):
    from .race_visuals import create_race_effects, css_for_skin, normalize_skin, palette_for_skin
    from .window_chrome import build_window_controls, install_window_interactions

    class SessionPanel(QtWidgets.QWidget):
        userClosed = QtCore.Signal()

        def __init__(self):
            super().__init__(None, QtCore.Qt.Tool | QtCore.Qt.WindowStaysOnTopHint | QtCore.Qt.FramelessWindowHint)
            self.owner = parent
            self._closed = False
            self._enabled = False
            self._skin = "default"
            self._snapshot = {}
            self._presentation = session_presentation({})
            self.setObjectName("sessionPanel")
            self.setWindowTitle("SC2TOOLS · Session record")
            self.setFont(QtGui.QFont("Segoe UI", 10))
            self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
            self.setAttribute(QtCore.Qt.WA_QuitOnClose, False)
            self.setAttribute(QtCore.Qt.WA_StyledBackground)
            self.setStyleSheet(_STYLE)
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(12, 9, 12, 9)
            layout.setSpacing(3)
            self.header = QtWidgets.QWidget(self)
            header = QtWidgets.QHBoxLayout(self.header)
            header.setContentsMargins(0, 0, 0, 0)
            header.setSpacing(3)
            self.title = self._label("Session", "sessionTitle")
            self.title.setAlignment(QtCore.Qt.AlignLeft | QtCore.Qt.AlignVCenter)
            header.addWidget(self.title, 1)
            self.window_controls = build_window_controls(self.header, window=self, QtCore=QtCore, QtWidgets=QtWidgets)
            self.window_controls.maximize_button.hide()
            header.addWidget(self.window_controls)
            layout.addWidget(self.header)
            record = QtWidgets.QHBoxLayout()
            record.setSpacing(6)
            self.wins_label = self._label("—W", "sessionWins")
            self.losses_label = self._label("—L", "sessionLosses")
            self.wins_label.setMinimumHeight(33)
            self.losses_label.setMinimumHeight(33)
            record.addWidget(self.wins_label, 1)
            record.addWidget(self.losses_label, 1)
            layout.addLayout(record, 1)
            self.rating_label = self._label("MMR —", "sessionRating")
            layout.addWidget(self.rating_label)
            self.region_label = self._label("Rating region —", "sessionRegion")
            layout.addWidget(self.region_label)
            self.elapsed_label = self._label("—", "sessionElapsed")
            layout.addWidget(self.elapsed_label)
            self.setMinimumSize(150, 138)
            self.resize(150, 138)
            self._timer = QtCore.QTimer(self)
            self._timer.setInterval(1000)
            self._timer.timeout.connect(self._render)
            self._race_effects = create_race_effects(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
            self._window_interactions = install_window_interactions(
                self, drag_widgets=[self.header, self.wins_label, self.losses_label, self.rating_label,
                                    self.region_label, self.elapsed_label],
                QtCore=QtCore, QtWidgets=QtWidgets, can_maximize=lambda: False,
            )
            self._render()

        def _label(self, text, name):
            widget = QtWidgets.QLabel(text)
            widget.setObjectName(name)
            widget.setTextFormat(QtCore.Qt.PlainText)
            widget.setAlignment(QtCore.Qt.AlignCenter)
            widget.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            return widget

        def _render(self):
            if self._closed:
                return
            view = session_presentation(self._snapshot)
            self._presentation = view
            for widget, key in ((self.wins_label, "winsText"), (self.losses_label, "lossesText")):
                text = view[key]
                font = widget.font()
                font.setBold(True)
                for pixels in range(29, 9, -1):
                    font.setPixelSize(pixels)
                    if QtGui.QFontMetrics(font).horizontalAdvance(text) <= max(1, widget.width()):
                        break
                widget.setFont(font)
                widget.setStyleSheet(f"font-size: {pixels}px; font-weight: 700;")
                widget.setText(widget.fontMetrics().elidedText(text, QtCore.Qt.ElideMiddle, max(1, widget.width())))
                widget.setToolTip(text)
                widget.setAccessibleName("Session wins" if key == "winsText" else "Session losses")
                widget.setAccessibleDescription(text)
            for widget, key, title in ((self.rating_label, "ratingText", "Your latest-known MMR"),
                                       (self.region_label, "regionText", "Your rating region, not a verified active server")):
                widget.setText(widget.fontMetrics().elidedText(view[key], QtCore.Qt.ElideRight, max(1, widget.width())))
                widget.setToolTip(view["description"])
                widget.setAccessibleName(title)
                widget.setAccessibleDescription(view[key])
            footer = view["elapsedText"]
            self.elapsed_label.setText(self.elapsed_label.fontMetrics().elidedText(footer, QtCore.Qt.ElideRight,
                                                                                  max(1, self.elapsed_label.width())))
            self.elapsed_label.setToolTip(view["description"])
            self.elapsed_label.setAccessibleName("Session elapsed time")
            self.elapsed_label.setAccessibleDescription(view["description"])
            self.setAccessibleName("Session record")
            self.setAccessibleDescription(view["description"])
            self.title.setToolTip(view["description"])

        def update_session(self, snapshot):
            if self._closed:
                return
            source = snapshot if isinstance(snapshot, dict) else {}
            self._snapshot = {key: source.get(key) for key in ("paired", "accountKey", "receivedAt", "source")}
            rating = source.get("ownRating")
            self._snapshot["ownRating"] = {key: rating.get(key) for key in ("mmr", "source", "status")} if isinstance(rating, dict) else None
            session = source.get("session")
            self._snapshot["session"] = {key: session.get(key) for key in
                                         ("wins", "losses", "games", "region", "sessionStartedAt")} if isinstance(session, dict) else None
            self._render()

        def set_enabled(self, enabled):
            if self._closed:
                return
            enabled = enabled is True
            restore = enabled and not self._enabled
            self._enabled = enabled
            if enabled:
                self._render()
                self._timer.start()
                if restore:
                    self.showNormal()
                elif not self.isVisible():
                    self.show()
            else:
                self._timer.stop()
                self.hide()

        def set_appearance(self, skin, animations):
            if self._closed:
                return
            skin = normalize_skin(skin)
            self._skin = skin
            override = css_for_skin(skin)
            colors = palette_for_skin(skin)
            frame = f"QWidget#sessionPanel {{ border-color: {colors['border']}; }}" if skin != "default" else ""
            self.setStyleSheet(_STYLE + override + frame)
            self.window_controls.setStyleSheet(theme.WINDOW_CONTROLS_STYLE + override)
            self._race_effects.apply_skin(skin)
            self._race_effects.set_motion_enabled(animations)

        def showEvent(self, event):
            super().showEvent(event)
            self.window_controls.setStyleSheet(theme.WINDOW_CONTROLS_STYLE + css_for_skin(self._skin))

        def resizeEvent(self, event):
            super().resizeEvent(event)
            if hasattr(self, "_snapshot") and hasattr(self, "elapsed_label"):
                self._render()

        def closeEvent(self, event):
            self._timer.stop()
            was_enabled = self._enabled
            self._enabled = False
            if was_enabled and not self._closed:
                self.userClosed.emit()
            event.accept()

        def shutdown(self):
            if not self._closed:
                self._closed = True
                self._enabled = False
                self._snapshot = {}
                self._timer.stop()
                self._race_effects.shutdown()
                self.hide()

    return SessionPanel()
