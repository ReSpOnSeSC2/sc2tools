"""Qt-free race skin tokens and lazily constructed decorative window effects."""
from __future__ import annotations

from . import theme
from .race_artwork import create_race_artwork
from .race_materials import TERRAN_PALETTE, ZERG_PALETTE, paint_terran_border, paint_zerg_border


RACE_SKINS = (("Default", "default"), ("Protoss", "protoss"), ("Terran", "terran"), ("Zerg", "zerg"))
EXPAND_DURATION_MS = 450
PROTOSS_GOLD_STOPS = ((0.0, "#fff0b8"), (0.15, "#b17a32"), (0.34, "#edcf86"),
                      (0.58, "#ac7937"), (0.78, "#f6dc9d"), (1.0, "#3a2817"))
_PALETTES = {
    "default": {"frame": theme.BUTTON, "border": theme.ACCENT, "accent": theme.ACCENT_CYAN,
                "plate": theme.SUBTLE, "surface": theme.SURFACE, "glow": theme.FOCUS},
    "protoss": {"frame": "#69502c", "border": "#e2c271", "accent": "#7ae8e5",
                "plate": "#382d25", "surface": theme.SURFACE, "glow": "#b6ffff"},
    "terran": dict(TERRAN_PALETTE),
    "zerg": dict(ZERG_PALETTE),
}


def normalize_skin(value):
    key = value.strip().lower() if isinstance(value, str) else "default"
    return key if key in _PALETTES else "default"


def palette_for_skin(skin):
    return dict(_PALETTES[normalize_skin(skin)])


def css_for_skin(skin):
    skin = normalize_skin(skin)
    if skin == "default":
        return ""
    colors = palette_for_skin(skin)
    frame_background = ("qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #242329,stop:0.5 #14131b,stop:1 #1b1820)"
                        if skin == "protoss" else
                        f"qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 {colors['frame']},stop:1 {colors['plate']})")
    return f"""
QFrame#agentFrame, QFrame#companionConsole {{
    background: {frame_background};
    border-color: {colors['border']};
}}
QFrame#agentSidebar, QFrame#agentDisplay, QFrame#consoleProfile, QFrame#consoleDisplay,
QFrame#card, QFrame#cardElevated, QFrame#companionCard,
QFrame#studioCard, QFrame#studioDestination, QFrame#studioCommand {{ border-color: {colors['border']}; }}
QPushButton, QToolButton, QPushButton#primary, QPushButton#checkinPrimary,
QToolButton#windowMinimize, QToolButton#windowMaximize, QToolButton#windowClose,
QFrame#companionConsole QPushButton, QFrame#companionConsole QToolButton,
QWidget#companionDesk QPushButton, QWidget#companionPanel QPushButton,
QWidget#ghostDesk QPushButton {{ background: {colors['frame']}; border-color: {colors['border']}; }}
QPushButton:hover, QToolButton:hover, QPushButton#primary:hover, QPushButton#checkinPrimary:hover,
QFrame#companionConsole QPushButton:hover, QFrame#companionConsole QToolButton:hover,
QWidget#companionDesk QPushButton:hover, QWidget#companionPanel QPushButton:hover,
QWidget#ghostDesk QPushButton:hover {{ background: {colors['plate']}; border-color: {colors['accent']}; }}
QPushButton:checked, QToolButton:checked, QTabBar::tab:selected,
QFrame#companionConsole QPushButton:checked, QFrame#companionConsole QToolButton:checked,
QWidget#companionDesk QPushButton:checked, QWidget#ghostDesk QPushButton:checked {{
    background: {colors['plate']}; border-color: {colors['accent']};
}}
QLineEdit, QComboBox, QPlainTextEdit, QTextEdit, QAbstractSpinBox,
QTreeView, QTreeWidget, QTableView, QTableWidget, QListView, QListWidget, QGroupBox,
QWidget#companionDesk QLineEdit, QWidget#companionDesk QComboBox, QWidget#companionDesk QPlainTextEdit,
QWidget#ghostDesk QLineEdit, QWidget#ghostDesk QComboBox, QWidget#ghostDesk QTreeWidget {{ border-color: {colors['border']}; }}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus, QTextEdit:focus,
QAbstractSpinBox:focus, QTreeView:focus, QTableView:focus, QListView:focus,
QPushButton#navItem:checked, QTabBar::tab:selected {{ border-color: {colors['accent']}; }}
QCheckBox::indicator:checked, QRadioButton::indicator:checked {{
    background: {colors['accent']}; border-color: {colors['border']};
}}
QTreeView::item:selected, QTreeWidget::item:selected,
QTableView::item:selected, QTableWidget::item:selected,
QListView::item:selected, QListWidget::item:selected {{ border-color: {colors['accent']}; }}
QPushButton#danger, QPushButton#dangerButton {{ color: {theme.DANGER}; border-color: rgba(241,109,109,0.55); }}
QPushButton#danger:hover, QPushButton#dangerButton:hover,
QFrame#companionConsole QPushButton#danger:hover, QFrame#companionConsole QPushButton#dangerButton:hover {{
    background: rgba(241,109,109,0.10); border-color: {theme.DANGER};
}}
QToolButton#windowClose:hover, QFrame#companionConsole QToolButton#windowClose:hover {{
    background: #8c345d; border-color: {theme.DANGER};
}}
"""


def create_race_effects(window, *, QtCore, QtGui, QtWidgets, compact_bezel=False):
    """Decorate this window without changing its geometry, focus or input routing."""

    class RaceOverlay(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(window)
            self.setObjectName("raceVisualOverlay")
            self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
            self.setAttribute(QtCore.Qt.WA_NoSystemBackground)
            self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
            self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
            self.setFocusPolicy(QtCore.Qt.NoFocus)
            self.setAccessibleName("Decorative race border")
            self.skin = "default"
            self.progress = None
            self.artwork = create_race_artwork(QtCore=QtCore, QtGui=QtGui, compact_bezel=compact_bezel)
            self.hide()

        def _color(self, key, alpha=255):
            color = QtGui.QColor(_PALETTES[self.skin][key])
            color.setAlpha(alpha)
            return color

        def _pen(self, key, alpha=255, width=1.3):
            pen = QtGui.QPen(self._color(key, alpha), width)
            pen.setCapStyle(QtCore.Qt.RoundCap)
            return pen

        def _corners(self, painter, rectangle, draw):
            for horizontal, vertical in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
                painter.save()
                painter.translate(rectangle.left() if horizontal == 1 else rectangle.right(),
                                  rectangle.top() if vertical == 1 else rectangle.bottom())
                painter.scale(horizontal, vertical)
                draw(painter)
                painter.restore()

        def paintEvent(self, event):
            if self.skin == "default":
                return
            painter = QtGui.QPainter(self)
            painter.setRenderHint(QtGui.QPainter.Antialiasing)
            painter.setClipRect(self.rect())
            painter.setBrush(QtCore.Qt.NoBrush)
            rectangle = QtCore.QRectF(self.rect()).adjusted(2, 2, -3, -3)
            painter.setPen(self._pen("border", 220))
            if not self.artwork.paint(painter, self.skin, rectangle):
                if self.skin == "protoss":
                    self._protoss_border(painter, rectangle)
                elif self.skin == "terran":
                    self._terran_border(painter, rectangle)
                else:
                    self._zerg_border(painter, rectangle)
            if self.progress is not None:
                progress = max(0.0, min(1.0, self.progress))
                alpha = int(145 * (1 - progress))
                if self.skin == "protoss":
                    self._warp(painter, rectangle, progress, alpha)
                elif self.skin == "terran":
                    self._rails(painter, rectangle, progress, alpha)
                else:
                    self._hatch(painter, rectangle, progress, alpha)

        def _protoss_border(self, painter, rectangle):
            compact = compact_bezel or rectangle.height() < 140
            depth = 3.2 if compact else 10.5
            scale = depth / 10.5

            def outline(bounds, corner):
                path = QtGui.QPainterPath(QtCore.QPointF(bounds.left() + corner, bounds.top()))
                for point in ((bounds.right() - corner, bounds.top()), (bounds.right(), bounds.top() + corner),
                              (bounds.right(), bounds.bottom() - corner), (bounds.right() - corner, bounds.bottom()),
                              (bounds.left() + corner, bounds.bottom()), (bounds.left(), bounds.bottom() - corner),
                              (bounds.left(), bounds.top() + corner)):
                    path.lineTo(*point)
                path.closeSubpath()
                return path

            outer = outline(rectangle, 12 * scale)
            inner = outline(rectangle.adjusted(depth, depth, -depth, -depth), 6 * scale)
            ring = outer.subtracted(inner)
            painter.fillPath(ring, QtGui.QColor("#624220"))
            painter.save()
            painter.setClipPath(ring, QtCore.Qt.IntersectClip)
            for bounds, start, end in (
                (QtCore.QRectF(rectangle.left(), rectangle.top(), rectangle.width(), depth),
                 rectangle.topLeft(), rectangle.topLeft() + QtCore.QPointF(0, depth)),
                (QtCore.QRectF(rectangle.left(), rectangle.bottom() - depth, rectangle.width(), depth),
                 rectangle.bottomLeft(), rectangle.bottomLeft() - QtCore.QPointF(0, depth)),
                (QtCore.QRectF(rectangle.left(), rectangle.top(), depth, rectangle.height()),
                 rectangle.topLeft(), rectangle.topLeft() + QtCore.QPointF(depth, 0)),
                (QtCore.QRectF(rectangle.right() - depth, rectangle.top(), depth, rectangle.height()),
                 rectangle.topRight(), rectangle.topRight() - QtCore.QPointF(depth, 0)),
            ):
                metal = QtGui.QLinearGradient(start, end)
                for position, color in PROTOSS_GOLD_STOPS:
                    metal.setColorAt(position, QtGui.QColor(color))
                painter.fillRect(bounds, metal)
            painter.restore()
            painter.setBrush(QtCore.Qt.NoBrush)
            painter.setPen(QtGui.QPen(QtGui.QColor("#fbe5a6"), 0.9))
            painter.drawPath(outer)
            painter.setPen(QtGui.QPen(QtGui.QColor("#25180e"), 1.6 if not compact else 0.8))
            painter.drawPath(inner)
            channel = outline(rectangle.adjusted(depth * 0.61, depth * 0.61, -depth * 0.61, -depth * 0.61), 9 * scale)
            painter.setPen(QtGui.QPen(QtGui.QColor("#302d26"), 3.1 if not compact else 1.3))
            painter.drawPath(channel)
            painter.setPen(self._pen("accent", 65, 4 if not compact else 1.5))
            painter.drawPath(channel)
            painter.setPen(QtGui.QPen(QtGui.QColor("#98f4f5"), 1.0 if not compact else 0.7))
            painter.drawPath(channel)

            def crystal(surface, center, radius):
                center_x, center_y = center.x(), center.y()
                points = [QtCore.QPointF(center_x, center_y - radius), QtCore.QPointF(center_x + radius * 0.72, center_y),
                          QtCore.QPointF(center_x, center_y + radius), QtCore.QPointF(center_x - radius * 0.72, center_y)]
                surface.setPen(QtGui.QPen(QtGui.QColor("#382d21"), 1))
                surface.setBrush(QtGui.QColor("#55cfdf"))
                surface.drawPolygon(QtGui.QPolygonF(points))
                surface.setPen(QtCore.Qt.NoPen)
                for index, color in enumerate(("#d4ffff", "#3b9fbe", "#175e7a", "#7ae9ef")):
                    surface.setBrush(QtGui.QColor(color))
                    surface.drawPolygon(QtGui.QPolygonF([center, points[index], points[(index + 1) % 4]]))
                surface.setBrush(QtCore.Qt.NoBrush)

            def plate(surface):
                surface.scale(scale, scale)
                shape = QtGui.QPainterPath(QtCore.QPointF(0, 58))
                for point in ((0, 13), (13, 0), (58, 0), (51, 4), (29, 4), (20, 8),
                              (12, 12), (8, 20), (4, 29), (4, 51)):
                    shape.lineTo(*point)
                shape.closeSubpath()
                metal = QtGui.QLinearGradient(0, 0, 15, 15)
                for position, color in PROTOSS_GOLD_STOPS:
                    metal.setColorAt(position, QtGui.QColor(color))
                surface.setPen(QtGui.QPen(QtGui.QColor("#49321c"), 1))
                surface.setBrush(metal)
                surface.drawPath(shape)
                face = QtGui.QPainterPath(QtCore.QPointF(1, 43))
                for point in ((1, 14), (14, 1), (43, 1), (38, 4), (18, 4), (4, 18), (4, 38)):
                    face.lineTo(*point)
                face.closeSubpath()
                surface.setBrush(QtGui.QColor("#e7c382"))
                surface.setPen(QtGui.QPen(QtGui.QColor("#fff0b7"), 0.7))
                surface.drawPath(face)
                surface.setBrush(QtCore.Qt.NoBrush)
                groove = QtGui.QPainterPath(QtCore.QPointF(5, 30))
                groove.lineTo(7, 21)
                groove.lineTo(14, 12)
                groove.lineTo(24, 6)
                groove.lineTo(34, 5)
                surface.setPen(QtGui.QPen(QtGui.QColor("#4f341c"), 3.2))
                surface.drawPath(groove)
                surface.setPen(QtGui.QPen(QtGui.QColor("#7feaf0"), 1.1))
                surface.drawPath(groove)
                crystal(surface, QtCore.QPointF(8, 8), 5)
            self._corners(painter, rectangle, plate)
            for position, direction in ((rectangle.bottom(), -1), (rectangle.top(), 1)):
                painter.save()
                painter.translate(rectangle.center().x(), position)
                painter.scale(scale, direction * scale)
                crest = QtGui.QPolygonF([QtCore.QPointF(*point) for point in
                                        ((-34, 0), (-23, 5), (-13, 5), (0, 12), (13, 5), (23, 5),
                                         (34, 0), (16, 2), (0, 7), (-16, 2))])
                metal = QtGui.QLinearGradient(0, 0, 0, 12)
                for fraction, color in PROTOSS_GOLD_STOPS:
                    metal.setColorAt(fraction, QtGui.QColor(color))
                painter.setBrush(metal)
                painter.setPen(QtGui.QPen(QtGui.QColor("#f2d897"), 0.8))
                painter.drawPolygon(crest)
                crystal(painter, QtCore.QPointF(0, 5), 4)
                painter.restore()
            painter.setBrush(QtCore.Qt.NoBrush)

        def _terran_border(self, painter, rectangle):
            paint_terran_border(self, painter, rectangle, QtCore=QtCore, QtGui=QtGui)

        def _zerg_border(self, painter, rectangle):
            paint_zerg_border(self, painter, rectangle, QtCore=QtCore, QtGui=QtGui)

        def _warp(self, painter, rectangle, progress, alpha):
            painter.setPen(self._pen("glow", alpha, 2))
            distance = rectangle.height() * progress / 2
            for position in (rectangle.center().y() - distance, rectangle.center().y() + distance):
                painter.drawLine(QtCore.QPointF(rectangle.left() + 8, position), QtCore.QPointF(rectangle.right() - 8, position))
            painter.setPen(self._pen("accent", alpha // 2, 1))
            width = rectangle.width() * (0.2 + progress * 0.8)
            height = rectangle.height() * (0.2 + progress * 0.8)
            painter.drawRoundedRect(QtCore.QRectF(rectangle.center().x() - width / 2,
                                               rectangle.center().y() - height / 2, width, height), 8, 8)
            for shift in (0.0, 0.18):
                radius = min(1.0, progress + shift)
                ring = QtCore.QRectF(rectangle.center().x() - rectangle.width() * radius / 2,
                                     rectangle.center().y() - rectangle.height() * radius / 3,
                                     rectangle.width() * radius, rectangle.height() * radius * 2 / 3)
                painter.setPen(self._pen("glow" if shift else "border", alpha // 2, 1.4))
                painter.drawEllipse(ring)

        def _rails(self, painter, rectangle, progress, alpha):
            eased = 1 - (1 - progress) ** 3
            offset = rectangle.width() * eased / 2
            painter.setPen(self._pen("border", alpha, 3))
            for edge, direction in ((rectangle.center().x() - offset, 1), (rectangle.center().x() + offset, -1)):
                shutter = QtCore.QRectF(edge - 2, rectangle.top() + 5, 4, rectangle.height() - 10)
                painter.fillRect(shutter, self._color("frame", alpha))
                painter.drawLine(QtCore.QPointF(edge, rectangle.top() + 5), QtCore.QPointF(edge, rectangle.bottom() - 5))
                painter.setPen(self._pen("accent", alpha, 1.3))
                for position in (rectangle.top() + 12, rectangle.bottom() - 12):
                    painter.drawLine(QtCore.QPointF(edge, position), QtCore.QPointF(edge + direction * 15, position))
                painter.setPen(self._pen("border", alpha, 3))
                for position in (rectangle.top() + 9, rectangle.bottom() - 9):
                    anchor = rectangle.left() + 7 if direction == 1 else rectangle.right() - 7
                    shaft_end = edge - direction * 4
                    if (shaft_end - anchor) * direction <= 0:
                        continue
                    barrel_length = min(27.0, abs(shaft_end - anchor) * 0.6)
                    barrel_end = anchor + direction * barrel_length
                    painter.setPen(self._pen("glow", alpha, 2))
                    painter.drawLine(QtCore.QPointF(barrel_end, position), QtCore.QPointF(shaft_end, position))
                    steel = QtGui.QLinearGradient(0, position - 3, 0, position + 3)
                    steel.setColorAt(0, self._color("border", alpha))
                    steel.setColorAt(0.45, self._color("glow", alpha))
                    steel.setColorAt(1, self._color("frame", alpha))
                    painter.setBrush(steel)
                    painter.setPen(self._pen("border", alpha, 0.8))
                    painter.drawRoundedRect(QtCore.QRectF(min(anchor, barrel_end), position - 3, barrel_length, 6), 2, 2)
                    painter.setPen(self._pen("accent", alpha, 1.2))
                    painter.drawLine(QtCore.QPointF(barrel_end, position - 3), QtCore.QPointF(barrel_end, position + 3))
                    painter.setBrush(QtCore.Qt.NoBrush)
                painter.setPen(self._pen("border", alpha, 3))

        def _hatch(self, painter, rectangle, progress, alpha):
            offset = rectangle.width() * (1 - (1 - progress) ** 2) / 2
            for edge, direction in ((rectangle.center().x() - offset, 1), (rectangle.center().x() + offset, -1)):
                seam = QtGui.QPainterPath(QtCore.QPointF(edge, rectangle.top() + 4))
                seam.cubicTo(edge + direction * 16, rectangle.height() * 0.25,
                             edge - direction * 16, rectangle.height() * 0.75, edge, rectangle.bottom() - 4)
                painter.setPen(self._pen("glow", alpha, 2.2))
                painter.drawPath(seam)
                painter.setPen(self._pen("accent", alpha // 2, 1))
                for fraction in (0.25, 0.5, 0.75):
                    center = rectangle.top() + rectangle.height() * fraction
                    rib = QtGui.QPainterPath(QtCore.QPointF(edge, center - 8))
                    rib.quadTo(edge + direction * 22, center, edge + direction * 7, center + 8)
                    painter.drawPath(rib)
                    petal = QtGui.QPainterPath(QtCore.QPointF(edge, center - 20))
                    petal.cubicTo(edge + direction * 22, center - 26, edge + direction * 35, center - 6,
                                  edge + direction * 14, center + 20)
                    petal.quadTo(edge + direction * 5, center + 6, edge, center - 20)
                    painter.setBrush(self._color("frame", alpha // 5))
                    painter.setPen(self._pen("border", alpha // 2, 1))
                    painter.drawPath(petal)
                    painter.setBrush(QtCore.Qt.NoBrush)

    class RaceEffects(QtCore.QObject):
        def __init__(self):
            super().__init__(window)
            self.skin = "default"
            self.motion_enabled = True
            self._closed = False
            self._frame_target = window
            self.overlay = RaceOverlay()
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(16)
            self.timer.timeout.connect(self._tick)
            self._clock = QtCore.QElapsedTimer()
            window.installEventFilter(self)

        def _sync(self):
            target = self._frame_target
            origin = QtCore.QPoint() if target is window else target.mapTo(window, QtCore.QPoint())
            self.overlay.setGeometry(QtCore.QRect(origin, target.size()))
            self.overlay.setVisible(not self._closed and self.skin != "default" and window.isVisible() and target.isVisible()
                                    and window.property("textOverlay") is not True and target.property("textOverlay") is not True)
            if self.overlay.isVisible():
                self.overlay.raise_()
                self.overlay.update()

        def set_frame_target(self, widget):
            target = window if widget is None else widget
            if not isinstance(target, QtWidgets.QWidget) or target.window() is not window:
                raise ValueError("The decorative frame target must belong to this window")
            if self._closed:
                return
            if target is not self._frame_target:
                self.cancel()
                if self._frame_target is not window:
                    self._frame_target.removeEventFilter(self)
                self._frame_target = target
                if target is not window:
                    target.installEventFilter(self)
            self._sync()

        def apply_skin(self, skin):
            if self._closed:
                return
            self.cancel()
            self.skin = normalize_skin(skin)
            self.overlay.skin = self.skin
            self._sync()

        def play_expand(self):
            self.cancel()
            if (self._closed or not self.motion_enabled or self.skin == "default" or not window.isVisible()
                    or window.isMinimized() or not self._frame_target.isVisible()
                    or window.property("textOverlay") is True or self._frame_target.property("textOverlay") is True):
                return False
            self._clock.start()
            self.overlay.progress = 0.0
            self._sync()
            self.timer.start()
            return True

        def _tick(self):
            elapsed = self._clock.elapsed()
            if elapsed >= EXPAND_DURATION_MS:
                self.cancel()
                return
            self.overlay.progress = elapsed / EXPAND_DURATION_MS
            self.overlay.update()

        def cancel(self):
            self.timer.stop()
            self.overlay.progress = None
            self.overlay.update()

        def set_motion_enabled(self, enabled):
            self.motion_enabled = bool(enabled)
            if not self.motion_enabled:
                self.cancel()

        def eventFilter(self, watched, event):
            if watched is window or watched is self._frame_target:
                if event.type() in (QtCore.QEvent.Resize, QtCore.QEvent.Move, QtCore.QEvent.Show, QtCore.QEvent.ChildAdded):
                    self._sync()
                elif event.type() in (QtCore.QEvent.Hide, QtCore.QEvent.Close):
                    self.cancel()
                    self.overlay.hide()
                elif event.type() == QtCore.QEvent.WindowStateChange and window.isMinimized():
                    self.cancel()
            return False

        def shutdown(self):
            if not self._closed:
                self.cancel()
                self._closed = True
                window.removeEventFilter(self)
                if self._frame_target is not window:
                    self._frame_target.removeEventFilter(self)
                self.overlay.hide()

    return RaceEffects()
