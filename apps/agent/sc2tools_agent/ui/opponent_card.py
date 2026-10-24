"""Shared, local-asset opponent identity card for native Companion surfaces."""
from __future__ import annotations

import math
from pathlib import Path

from . import theme
from .race_visuals import normalize_skin, palette_for_skin


_RACES = {
    "p": "Protoss", "protoss": "Protoss", "t": "Terran", "terran": "Terran",
    "z": "Zerg", "zerg": "Zerg", "r": "Random", "random": "Random",
}
_PORTRAITS = {"Zerg": "hydralisk", "Terran": "marine", "Protoss": "zealot"}


def opponent_identity(name=None, race=None, mmr=None):
    clean_name = " ".join(name.split()) if isinstance(name, str) else ""
    clean_race = _RACES.get(race.strip().lower(), "—") if isinstance(race, str) else "—"
    try:
        valid_mmr = type(mmr) in {int, float} and math.isfinite(mmr) and mmr > 0
    except OverflowError:
        valid_mmr = False
    return {
        "name": clean_name[:256] or "—",
        "race": clean_race,
        "mmr": str(round(mmr)) if valid_mmr else "—",
    }


def opponent_record(wins=None, losses=None):
    def count(value):
        if type(value) is int and 0 <= value <= 2 ** 53 - 1:
            return value
        if type(value) is float and math.isfinite(value) and 0 <= value <= 2 ** 53 - 1 and value.is_integer():
            return int(value)
        return None

    wins, losses = count(wins), count(losses)
    if wins is None or losses is None:
        return {"wins": None, "losses": None, "text": "—", "winRate": "—"}
    total = wins + losses
    rate = f"{100 * wins / total:.1f}".rstrip("0").rstrip(".") + "%" if total else "—"
    return {"wins": wins, "losses": losses, "text": f"{wins}W · {losses}L", "winRate": rate}


def opponent_asset_root():
    packaged = Path(__file__).resolve().parent / "assets" / "sc2"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[3] / "web" / "public" / "icons" / "sc2"


def build_opponent_card(parent=None, *, QtCore, QtGui, QtWidgets, icon_root=None, layout="compact"):
    if layout not in {"compact", "profile"}:
        raise ValueError("Unknown opponent card layout")
    assets = Path(icon_root) if icon_root is not None else opponent_asset_root()
    profile = layout == "profile"

    class ElidedName(QtWidgets.QLabel):
        def set_full_text(self, value):
            self.full_text = value
            self.setToolTip(value if value != "—" else "Opponent name unavailable")
            self._update_elision()

        def _update_elision(self):
            self.setText(self.fontMetrics().elidedText(getattr(self, "full_text", "—"), QtCore.Qt.ElideRight, max(1, self.width())))

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._update_elision()

    class Portrait(QtWidgets.QWidget):
        def __init__(self, owner):
            super().__init__(owner)
            self.setObjectName("opponentPortrait")
            self.setAccessibleName("Race illustration")
            self.setAccessibleDescription("Decorative race-representative artwork, not a player portrait.")
            self._cache = {}
            self._image = QtGui.QPixmap()
            self.asset_path = None

        def set_race(self, race):
            if race not in self._cache:
                unit = _PORTRAITS.get(race)
                unit_path = assets / "units" / f"{unit}.png" if unit else None
                race_path = assets / "races" / f"{race.lower()}.svg"
                image = QtGui.QPixmap(str(unit_path)) if unit_path and unit_path.is_file() else QtGui.QPixmap()
                path = unit_path if not image.isNull() else None
                if image.isNull() and race_path.is_file():
                    image = QtGui.QIcon(str(race_path)).pixmap(100, 100)
                    path = race_path if not image.isNull() else None
                self._cache[race] = image, path
            self._image, self.asset_path = self._cache[race]
            self.setToolTip(f"{race} illustration" if race != "—" else "Race unavailable")
            self.update()

        def paintEvent(self, event):
            painter = QtGui.QPainter(self)
            painter.setRenderHint(QtGui.QPainter.Antialiasing)
            rectangle = QtCore.QRectF(self.rect()).adjusted(1, 1, -1, -1)
            gradient = QtGui.QLinearGradient(rectangle.topLeft(), rectangle.bottomRight())
            gradient.setColorAt(0, QtGui.QColor("#625b69"))
            gradient.setColorAt(1, QtGui.QColor("#28212f"))
            path = QtGui.QPainterPath()
            path.addRoundedRect(rectangle, 5, 5)
            painter.fillPath(path, gradient)
            painter.save()
            painter.setClipPath(path)
            painter.setPen(QtGui.QPen(QtGui.QColor(191, 179, 199, 27), 1))
            for offset in range(-self.height(), self.width() + self.height(), 18):
                painter.drawLine(offset, 0, offset + self.height(), self.height())
                painter.drawLine(offset, 0, offset - self.height(), self.height())
            painter.setPen(QtCore.Qt.NoPen)
            painter.setBrush(QtGui.QColor(7, 3, 12, 85))
            painter.drawEllipse(QtCore.QRectF(self.width() * 0.16, self.height() * 0.72, self.width() * 0.68, self.height() * 0.13))
            if not self._image.isNull():
                size = self._image.size().scaled(max(1, self.width() - 15), max(1, self.height() - 18), QtCore.Qt.KeepAspectRatio)
                destination = QtCore.QRect((self.width() - size.width()) // 2, (self.height() - size.height()) // 2, size.width(), size.height())
                painter.setRenderHint(QtGui.QPainter.SmoothPixmapTransform)
                painter.drawPixmap(destination, self._image)
            else:
                painter.setPen(QtGui.QColor("#c4b3d1"))
                font = painter.font()
                font.setPixelSize(32)
                font.setBold(True)
                painter.setFont(font)
                painter.drawText(self.rect(), QtCore.Qt.AlignCenter, "?")
            painter.restore()
            painter.setPen(QtGui.QPen(QtGui.QColor("#c2b0ca"), 1))
            painter.setBrush(QtCore.Qt.NoBrush)
            painter.drawRoundedRect(rectangle, 5, 5)

    class OpponentCard(QtWidgets.QWidget):
        enlargeRequested = QtCore.Signal()
        scoutingRequested = QtCore.Signal()
        minimizeRequested = QtCore.Signal()
        closeRequested = QtCore.Signal()

        def __init__(self):
            super().__init__(parent)
            self.setObjectName("opponentIdentityCard")
            self.layout_mode = layout
            self.setProperty("textOverlay", not profile)
            if not profile:
                self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
            self._skin = "default"
            self.setProperty("raceSkin", "default")
            self.setMinimumSize(220, 340) if profile else self.setMinimumSize(360, 40)
            self.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Expanding)
            self.setStyleSheet("QWidget#opponentIdentityCard { background: transparent; } QLabel { background: transparent; border: none; font-family: 'Segoe UI', sans-serif; }")
            self.portrait = Portrait(self)
            self.name_label = ElidedName(self)
            self.name_label.setObjectName("opponentCardName")
            self.name_label.setStyleSheet("color: #f6effa; font-size: 21px; font-weight: 700;")
            self.race_caption = QtWidgets.QLabel("RACE", self)
            self.mmr_caption = QtWidgets.QLabel("MMR", self)
            self.race_label = QtWidgets.QLabel(self)
            self.mmr_label = QtWidgets.QLabel(self)
            self.race_label.setObjectName("opponentCardRace")
            self.mmr_label.setObjectName("opponentCardMmr")
            self.record_caption = QtWidgets.QLabel("YOUR RECORD", self)
            self.win_rate_caption = QtWidgets.QLabel("YOUR WIN RATE", self)
            self.record_label = QtWidgets.QLabel(self)
            self.win_rate_label = QtWidgets.QLabel(self)
            self.record_label.setObjectName("opponentCardRecord")
            self.win_rate_label.setObjectName("opponentCardWinRate")
            for caption in (self.race_caption, self.mmr_caption, self.record_caption, self.win_rate_caption):
                caption.setStyleSheet("color: #a3e8b6; font-size: 10px; font-weight: 700;")
            self.race_label.setStyleSheet("color: #f0eaf5; font-size: 14px; font-weight: 600;")
            self.mmr_label.setStyleSheet("color: #f6effa; font-size: 26px; font-weight: 700;")
            for label in (self.record_label, self.win_rate_label):
                label.setStyleSheet("color: #f0eaf5; font-size: 19px; font-weight: 600;")
            for label in (self.name_label, self.race_caption, self.mmr_caption, self.race_label, self.mmr_label,
                          self.record_caption, self.win_rate_caption, self.record_label, self.win_rate_label):
                label.setTextFormat(QtCore.Qt.PlainText)
                label.setAlignment(QtCore.Qt.AlignLeft | QtCore.Qt.AlignVCenter)
            self.enlarge_button = QtWidgets.QToolButton(self)
            self.enlarge_button.setObjectName("opponentCardEnlarge")
            self.enlarge_button.setText("Expand")
            self.enlarge_button.setAccessibleName("Enlarge Companion")
            self.enlarge_button.setToolTip("Enlarge Companion · Standard view")
            self.enlarge_button.setCursor(QtCore.Qt.PointingHandCursor)
            self.enlarge_button.setStyleSheet("QToolButton { color: #f8eeff; background: #572080; border: 1px solid #bc7ce7; border-radius: 4px; font: 600 11px 'Segoe UI'; padding: 0; } QToolButton:hover { background: #7932aa; } QToolButton:focus { border: 2px solid #a8f3ec; } QToolButton:checked { border: 2px solid #a8f3ec; }")
            self._enlarge_base_style = self.enlarge_button.styleSheet()
            self.enlarge_button.clicked.connect(lambda _checked=False: self.enlargeRequested.emit())
            self.scouting_button = QtWidgets.QToolButton(self)
            self.scouting_button.setObjectName("opponentCardScout")
            self.scouting_button.setText("")
            self.scouting_button.setAccessibleName("Toggle scouting panel")
            self.scouting_button.setToolTip("Open scouting report")
            self.scouting_button.setCheckable(True)
            self.scouting_button.setFocusPolicy(QtCore.Qt.NoFocus)
            self.scouting_button.setCursor(QtCore.Qt.PointingHandCursor)
            self._style_scouting_button()
            self.scouting_button.setVisible(not profile)
            self.scouting_button.clicked.connect(lambda _checked=False: self.scoutingRequested.emit())
            self.minimize_button = QtWidgets.QToolButton(self)
            self.close_button = QtWidgets.QToolButton(self)
            for button, name, text, title, signal in (
                (self.minimize_button, "windowMinimize", "−", "Minimize Companion", self.minimizeRequested),
                (self.close_button, "windowClose", "×", "Close Companion", self.closeRequested),
            ):
                button.setObjectName(name)
                button.setText(text)
                button.setAccessibleName(title)
                button.setToolTip(title)
                button.setStyleSheet(theme.WINDOW_CONTROLS_STYLE)
                button.setCursor(QtCore.Qt.PointingHandCursor)
                button.clicked.connect(lambda _checked=False, requested=signal: requested.emit())
                button.hide()
            if not profile:
                self.portrait.hide()
                self.enlarge_button.hide()
                for text_label in (self.name_label, self.race_caption, self.mmr_caption, self.record_caption,
                                   self.win_rate_caption, self.race_label, self.mmr_label, self.record_label, self.win_rate_label):
                    shadow = QtWidgets.QGraphicsDropShadowEffect(text_label)
                    shadow.setColor(QtGui.QColor(0, 0, 0, 220))
                    shadow.setBlurRadius(3)
                    shadow.setOffset(0, 1)
                    text_label.setGraphicsEffect(shadow)
            self._compact_font = None
            self.set_identity()

        def sizeHint(self):
            return QtCore.QSize(260, 380) if profile else QtCore.QSize(420, 44)

        def set_identity(self, name=None, race=None, mmr=None, *, wins=None, losses=None):
            self.identity = opponent_identity(name, race, mmr)
            self.record = opponent_record(wins, losses)
            self.name_label.set_full_text(self.identity["name"])
            self.race_label.setText(self.identity["race"])
            self.mmr_label.setText(self.identity["mmr"])
            self.mmr_label.setToolTip("Matchmaking rating" if self.identity["mmr"] != "—" else "MMR unavailable")
            self.record_label.setText(self.record["text"])
            self.record_label.setToolTip("Your wins and losses against this opponent: " + self.record["text"])
            self.win_rate_label.setText(self.record["winRate"])
            self.win_rate_label.setToolTip("Your win percentage against this opponent: " + self.record["winRate"])
            self.portrait.set_race(self.identity["race"])
            self.setAccessibleName("Opponent identity")
            self.setAccessibleDescription(f"Name: {self.identity['name']}. Race: {self.identity['race']}. MMR: {self.identity['mmr']}. Your record: {self.record['text']}. Your win rate: {self.record['winRate']}.")
            self._place_contents()

        def set_skin(self, skin):
            self._skin = normalize_skin(skin)
            self.setProperty("raceSkin", self._skin)
            colors = palette_for_skin(self._skin)
            for button in (self.enlarge_button, self.scouting_button):
                selector = "QToolButton#" + button.objectName()
                extra = "" if self._skin == "default" else f"{selector} {{ background: {colors['frame']}; border-color: {colors['border']}; }} {selector}:hover {{ background: {colors['plate']}; border-color: {colors['accent']}; }}"
                button.setStyleSheet(self._enlarge_base_style + extra)
            self._style_scouting_button()
            for button in (self.minimize_button, self.close_button):
                extra = "" if self._skin == "default" else f"QToolButton#{button.objectName()} {{ background: {colors['frame']}; border-color: {colors['border']}; }}"
                button.setStyleSheet(theme.WINDOW_CONTROLS_STYLE + extra)
            self.update()

        def _style_scouting_button(self):
            from .scouting_glyph import build_scouting_icon
            self.scouting_button.setIcon(build_scouting_icon(self._skin, QtCore=QtCore, QtGui=QtGui))
            self.scouting_button.setIconSize(QtCore.QSize(20, 20))
            self.scouting_button.setStyleSheet(
                "QToolButton, QToolButton:hover, QToolButton:checked, QToolButton:pressed, QToolButton:disabled "
                "{ background: transparent; border: none; padding: 0; }"
            )

        def set_scouting_state(self, *, opened, enabled):
            self.scouting_button.setChecked(opened)
            self.scouting_button.setEnabled(enabled)
            self.scouting_button.setToolTip(("Close" if opened else "Open") + " scouting report" if enabled else
                                            "Scouting is available during a live match with In-game assistance enabled and an allowed mode.")

        def set_waiting(self, *, in_game=False):
            self.set_identity()
            self.name_label.set_full_text("Waiting for opponent" if in_game else "Waiting for next match")
            self.setAccessibleName("Waiting for opponent")
            self.setAccessibleDescription("No current opponent information is available.")

        def _place_contents(self):
            if not profile:
                small = self.width() < 400
                if small != self._compact_font:
                    self._compact_font = small
                    self.name_label.setStyleSheet(f"color: {theme.TEXT}; font-size: {12 if small else 13}px; font-weight: 700;")
                    for caption in (self.race_caption, self.mmr_caption, self.record_caption, self.win_rate_caption):
                        caption.setStyleSheet(f"color: {theme.TEXT_MUTED}; font-size: 8px; font-weight: 600;")
                    for value in (self.race_label, self.mmr_label, self.record_label, self.win_rate_label):
                        value.setStyleSheet(f"color: {theme.TEXT}; font-size: {12 if small else 13}px; font-weight: 600;")
                self.scouting_button.setGeometry(self.width() - 30, (self.height() - 22) // 2, 22, 22)
                available = self.width() - 46
                name_width = round(available * 0.25)
                self.name_label.setGeometry(10, (self.height() - 20) // 2, name_width - 6, 20)
                left = 10 + name_width
                self._record_top = (self.height() - 29) // 2
                for proportion, caption, value in ((0.15, self.race_caption, self.race_label),
                                                    (0.14, self.mmr_caption, self.mmr_label),
                                                    (0.23, self.record_caption, self.record_label),
                                                    (0.23, self.win_rate_caption, self.win_rate_label)):
                    column_width = round(available * proportion)
                    caption.setGeometry(left, self._record_top, column_width - 4, 11)
                    value.setGeometry(left, self._record_top + 11, column_width - 4, 18)
                    left += column_width
                self.name_label._update_elision()
                return
            self.enlarge_button.setGeometry(self.width() - 58, 5, 50, 22)
            content_width = max(1, self.width() - 32)
            content_height = max(1, self.height() - 51)
            if profile:
                portrait_size = min(154, content_width - 12, max(80, content_height - 172))
                self.portrait.setGeometry((self.width() - portrait_size) // 2, 38, portrait_size, portrait_size)
                text_left, text_width = 18, max(1, self.width() - 36)
                name_top = 46 + portrait_size
                self.name_label.setAlignment(QtCore.Qt.AlignCenter)
                self.name_label.setGeometry(text_left, name_top, text_width, 32)
                stats_top = name_top + 39
                split = text_width // 2
            else:
                portrait_width = min(106, max(70, round(content_width * 0.31)))
                portrait_height = min(128, max(80, self.height() - 111))
                self.portrait.setGeometry(16, 35, portrait_width, portrait_height)
                text_left = 16 + portrait_width + 13
                text_width = max(1, self.width() - text_left - 16)
                self.name_label.setGeometry(text_left, 42, text_width, 32)
                stats_top = min(96, 35 + max(40, portrait_height // 2))
                split = max(68, round(text_width * 0.44))
            self.race_caption.setGeometry(text_left, stats_top, split - 4, 17)
            self.race_label.setGeometry(text_left, stats_top + 20, split - 4, 32)
            self.mmr_caption.setGeometry(text_left + split, stats_top, max(1, text_width - split), 17)
            self.mmr_label.setGeometry(text_left + split, stats_top + 18, max(1, text_width - split), 36)
            self._record_top = stats_top + 72 if profile else self.height() - 61
            record_left = 18 if profile else 16
            record_width = max(1, self.width() - record_left * 2)
            record_split = record_width // 2
            self.record_caption.setGeometry(record_left, self._record_top, record_split - 4, 17)
            self.record_label.setGeometry(record_left, self._record_top + 20, record_split - 4, 28)
            self.win_rate_caption.setGeometry(record_left + record_split, self._record_top, record_width - record_split, 17)
            self.win_rate_label.setGeometry(record_left + record_split, self._record_top + 20, record_width - record_split, 28)
            self.name_label._update_elision()

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._place_contents()

        def paintEvent(self, event):
            if not profile:
                return
            painter = QtGui.QPainter(self)
            painter.setRenderHint(QtGui.QPainter.Antialiasing)
            colors = palette_for_skin(self._skin) if self._skin != "default" else None
            outer = QtCore.QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
            bezel = QtGui.QLinearGradient(0, 0, 0, self.height())
            bezel.setColorAt(0, QtGui.QColor(colors["border"] if colors else "#ba52e7"))
            bezel.setColorAt(0.16, QtGui.QColor(colors["frame"] if colors else "#8735bd"))
            bezel.setColorAt(0.6, QtGui.QColor(colors["frame"] if colors else "#61268b"))
            bezel.setColorAt(1, QtGui.QColor(colors["plate"] if colors else "#412055"))
            painter.setPen(QtGui.QPen(QtGui.QColor(colors["border"] if colors else "#bc77df"), 1))
            painter.setBrush(bezel)
            painter.drawRoundedRect(outer, 11, 11)
            inset = QtCore.QRectF(6, 29, max(1, self.width() - 12), max(1, self.height() - 35))
            panel = QtGui.QLinearGradient(inset.topLeft(), inset.bottomRight())
            panel.setColorAt(0, QtGui.QColor(colors["surface"] if colors else "#1c112c"))
            panel.setColorAt(1, QtGui.QColor(colors["surface"] if colors else "#100b19"))
            painter.setPen(QtGui.QPen(QtGui.QColor(colors["plate"] if colors else "#342040"), 1))
            painter.setBrush(panel)
            painter.drawRoundedRect(inset, 6, 6)
            painter.setPen(QtGui.QPen(QtGui.QColor(colors["border"] if colors else "#4c2d61"), 1))
            painter.drawLine(16, self._record_top - 9, self.width() - 16, self._record_top - 9)
            shine = QtGui.QColor(colors["glow"]) if colors else QtGui.QColor(240, 198, 255)
            shine.setAlpha(90)
            painter.setPen(QtGui.QPen(shine, 1))
            painter.drawLine(13, 3, self.width() - 13, 3)
            jewel = QtGui.QRadialGradient(16, 13, 11)
            jewel.setColorAt(0, QtGui.QColor(colors["glow"] if colors else "#bcfaff"))
            jewel.setColorAt(0.45, QtGui.QColor(colors["accent"] if colors else "#35d4ed"))
            jewel.setColorAt(1, QtGui.QColor(colors["frame"] if colors else "#176c9b"))
            painter.setPen(QtGui.QPen(QtGui.QColor(colors["plate"] if colors else "#244b77"), 1))
            painter.setBrush(jewel)
            painter.drawEllipse(QtCore.QPointF(18, 16), 7, 7)
            painter.setPen(QtCore.Qt.NoPen)
            painter.setBrush(QtGui.QColor(colors["accent"] if colors else "#df96ee"))
            painter.drawEllipse(QtCore.QPointF(34, 16), 2, 2)

    return OpponentCard()
