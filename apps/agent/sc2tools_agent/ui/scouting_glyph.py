"""Original race-specific vector marks for the compact scouting control."""
from __future__ import annotations

from .race_visuals import normalize_skin, palette_for_skin


def build_scouting_icon(skin, *, QtCore, QtGui):
    skin = normalize_skin(skin)
    colors = palette_for_skin(skin)

    def render(highlighted):
        image = QtGui.QPixmap(48, 48)
        image.setDevicePixelRatio(2)
        image.fill(QtCore.Qt.transparent)
        painter = QtGui.QPainter(image)
        painter.setRenderHint(QtGui.QPainter.Antialiasing)
        edge = QtGui.QColor("#f1ffff" if highlighted else colors["border"])
        accent = QtGui.QColor(colors["accent"]).lighter(120 if highlighted else 100)
        gradient = QtGui.QLinearGradient(3, 3, 20, 22)
        gradient.setColorAt(0, QtGui.QColor(colors["plate"]))
        gradient.setColorAt(0.5, QtGui.QColor(colors["frame"]))
        gradient.setColorAt(1, QtGui.QColor(colors["border"]))
        painter.setPen(QtGui.QPen(edge, 1.4 if highlighted else 1.1, QtCore.Qt.SolidLine,
                                 QtCore.Qt.RoundCap, QtCore.Qt.RoundJoin))
        painter.setBrush(gradient)
        if skin == "protoss":
            crystal = QtGui.QPolygonF([QtCore.QPointF(*point) for point in ((12, 2), (18, 7), (12, 22), (6, 7))])
            crystal_light = QtGui.QLinearGradient(6, 7, 15, 20)
            crystal_light.setColorAt(0, QtGui.QColor(colors["glow"]))
            crystal_light.setColorAt(0.45, accent)
            crystal_light.setColorAt(1, QtGui.QColor("#194d63"))
            painter.setBrush(crystal_light)
            painter.drawPolygon(crystal)
            painter.setPen(QtGui.QPen(QtGui.QColor(colors["border"]), 1.6))
            for points in (((3, 7), (4, 15), (8, 20)), ((21, 7), (20, 15), (16, 20))):
                painter.drawPolyline(QtGui.QPolygonF([QtCore.QPointF(*point) for point in points]))
            painter.setPen(QtGui.QPen(QtGui.QColor(colors["glow"]), 0.8))
            painter.drawLine(QtCore.QPointF(12, 3), QtCore.QPointF(12, 20))
            painter.drawLine(QtCore.QPointF(6, 7), QtCore.QPointF(18, 7))
        elif skin == "terran":
            plate = QtGui.QPolygonF([QtCore.QPointF(*point) for point in
                                    ((6, 3), (18, 3), (21, 6), (21, 18), (18, 21), (6, 21), (3, 18), (3, 6))])
            painter.drawPolygon(plate)
            painter.setBrush(QtGui.QColor("#071827"))
            painter.setPen(QtGui.QPen(accent, 1))
            painter.drawRect(QtCore.QRectF(7, 7, 10, 10))
            painter.drawLine(QtCore.QPointF(12, 5), QtCore.QPointF(12, 9))
            painter.drawLine(QtCore.QPointF(12, 15), QtCore.QPointF(12, 19))
            painter.drawLine(QtCore.QPointF(5, 12), QtCore.QPointF(9, 12))
            painter.drawLine(QtCore.QPointF(15, 12), QtCore.QPointF(19, 12))
            painter.fillRect(QtCore.QRectF(11, 11, 2, 2), accent)
        elif skin == "zerg":
            shell = QtGui.QPainterPath(QtCore.QPointF(12, 2))
            shell.cubicTo(19, 3, 23, 8, 20, 16)
            shell.quadTo(17, 21, 12, 23)
            shell.quadTo(6, 21, 3, 15)
            shell.cubicTo(1, 8, 5, 3, 12, 2)
            painter.drawPath(shell)
            painter.setPen(QtGui.QPen(accent, 1.2))
            painter.setBrush(QtGui.QColor("#2b101c"))
            eye = QtGui.QPainterPath(QtCore.QPointF(5, 12))
            eye.cubicTo(9, 6, 16, 6, 19, 12)
            eye.cubicTo(16, 18, 9, 18, 5, 12)
            painter.drawPath(eye)
            painter.setPen(QtCore.Qt.NoPen)
            painter.setBrush(QtGui.QColor("#f2c778" if highlighted else "#dba75b"))
            painter.drawEllipse(QtCore.QRectF(9, 8, 6, 8))
            painter.setBrush(QtGui.QColor("#210e18"))
            painter.drawEllipse(QtCore.QRectF(11, 9, 2, 6))
            painter.setPen(QtGui.QPen(edge, 0.9))
            painter.drawLine(QtCore.QPointF(4, 6), QtCore.QPointF(2, 3))
            painter.drawLine(QtCore.QPointF(20, 6), QtCore.QPointF(22, 3))
        else:
            shield = QtGui.QPolygonF([QtCore.QPointF(*point) for point in
                                     ((12, 2), (21, 7), (18, 18), (12, 22), (6, 18), (3, 7))])
            painter.drawPolygon(shield)
            painter.setPen(QtGui.QPen(accent, 1.7, QtCore.Qt.SolidLine, QtCore.Qt.RoundCap, QtCore.Qt.RoundJoin))
            for top in (6, 12):
                painter.drawPolyline(QtGui.QPolygonF([QtCore.QPointF(7, top + 4), QtCore.QPointF(12, top), QtCore.QPointF(17, top + 4)]))
        painter.end()
        return image

    icon = QtGui.QIcon()
    icon.addPixmap(render(False), QtGui.QIcon.Normal, QtGui.QIcon.Off)
    active = render(True)
    icon.addPixmap(active, QtGui.QIcon.Normal, QtGui.QIcon.On)
    icon.addPixmap(active, QtGui.QIcon.Active, QtGui.QIcon.Off)
    icon.addPixmap(active, QtGui.QIcon.Active, QtGui.QIcon.On)
    return icon
