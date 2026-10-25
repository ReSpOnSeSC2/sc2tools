"""Original, Qt-lazy material painting for decorative race bezels."""
from __future__ import annotations

from . import theme


TERRAN_PALETTE = {
    "frame": "#2d4b67", "border": "#90adc9", "accent": "#8bbd6b",
    "plate": "#162b43", "surface": theme.SURFACE, "glow": "#daeaff",
}
ZERG_PALETTE = {
    "frame": "#432735", "border": "#b48372", "accent": "#d98057",
    "plate": "#21141f", "surface": theme.SURFACE, "glow": "#edb1c2",
}


def _perimeter(painter, rectangle, *, QtCore, QtGui):
    depth = 3.0 if rectangle.height() <= 100 else min(13.0, max(7.0, rectangle.height() * 0.032))
    outer = QtGui.QPainterPath()
    outer.addRect(rectangle)
    inner = QtGui.QPainterPath()
    inner.addRect(rectangle.adjusted(depth, depth, -depth, -depth))
    painter.setClipPath(outer.subtracted(inner), QtCore.Qt.IntersectClip)
    return depth


def _gradient(QtGui, stops, start, end):
    gradient = QtGui.QLinearGradient(*start, *end)
    for position, color in stops:
        gradient.setColorAt(position, color)
    return gradient


def _edge(painter, rectangle, edge):
    painter.save()
    if edge == "top":
        painter.translate(rectangle.left(), rectangle.top())
    elif edge == "bottom":
        painter.translate(rectangle.right(), rectangle.bottom())
        painter.rotate(180)
    elif edge == "left":
        painter.translate(rectangle.left(), rectangle.bottom())
        painter.rotate(-90)
    else:
        painter.translate(rectangle.right(), rectangle.top())
        painter.rotate(90)
    return rectangle.width() if edge in {"top", "bottom"} else rectangle.height()


def _steel_tube(overlay, painter, length, depth, *, QtCore, QtGui):
    diameter = depth * 0.39
    inset = min(34.0, length * 0.16)
    center = depth * 0.68
    painter.setPen(QtGui.QPen(QtGui.QColor("#0b1115"), diameter + 1.8))
    painter.drawLine(QtCore.QPointF(inset, center), QtCore.QPointF(length - inset, center))
    tube = _gradient(QtGui, ((0, overlay._color("plate")), (0.25, overlay._color("border")),
                            (0.46, overlay._color("glow")), (0.6, overlay._color("frame")),
                            (1, QtGui.QColor("#11191d"))),
                     (0, center - diameter / 2), (0, center + diameter / 2))
    painter.setPen(QtGui.QPen(QtGui.QBrush(tube), diameter))
    painter.drawLine(QtCore.QPointF(inset, center), QtCore.QPointF(length - inset, center))
    position = inset + 2
    spacing = 2.6 if depth <= 3 else 4.2
    while position < length - inset - 1:
        painter.setPen(QtGui.QPen(QtGui.QColor("#10191e"), 0.9))
        painter.drawLine(QtCore.QPointF(position, center - diameter / 2), QtCore.QPointF(position, center + diameter / 2))
        painter.setPen(overlay._pen("border", 180, 0.55))
        painter.drawLine(QtCore.QPointF(position + 0.8, center - diameter / 2), QtCore.QPointF(position + 0.8, center + diameter / 2))
        position += spacing
    if depth > 3:
        for position in (inset, length - inset):
            painter.fillRect(QtCore.QRectF(position - 2.4, center - diameter * 0.8, 4.8, diameter * 1.6), overlay._color("frame"))
            painter.setPen(overlay._pen("glow", 180, 0.7))
            painter.drawLine(QtCore.QPointF(position - 1.8, center - diameter * 0.7), QtCore.QPointF(position - 1.8, center + diameter * 0.7))


def _hazard_patch(overlay, painter, length, depth, *, QtCore, QtGui):
    width = min(32.0, length * 0.1)
    height = depth * 0.3
    left = length * 0.28 - width / 2
    top = depth * 0.08
    painter.save()
    painter.setClipRect(QtCore.QRectF(left, top, width, height), QtCore.Qt.IntersectClip)
    painter.fillRect(QtCore.QRectF(left, top, width, height), QtGui.QColor("#111611"))
    painter.setPen(QtCore.Qt.NoPen)
    painter.setBrush(QtGui.QColor("#c1a14a"))
    position = left - height
    spacing = max(3.0, height * 1.8)
    while position < left + width:
        painter.drawPolygon(QtGui.QPolygonF([QtCore.QPointF(position, top),
                                            QtCore.QPointF(position + spacing * 0.5, top),
                                            QtCore.QPointF(position + spacing * 0.5 + height, top + height),
                                            QtCore.QPointF(position + height, top + height)]))
        position += spacing
    painter.restore()


def _terran_corner(overlay, painter, depth, *, QtCore, QtGui):
    reach = min(36.0, depth * 3.1)
    shape = QtGui.QPainterPath(QtCore.QPointF(0, reach))
    for point in ((0, 4), (4, 0), (reach, 0), (reach - 4, depth * 0.48),
                  (depth * 0.7, depth * 0.48), (depth * 0.48, depth * 0.7), (depth * 0.48, reach - 4)):
        shape.lineTo(*point)
    shape.closeSubpath()
    steel = _gradient(QtGui, ((0, overlay._color("glow")), (0.18, overlay._color("border")),
                             (0.42, overlay._color("frame")), (0.65, overlay._color("plate")),
                             (1, overlay._color("border"))), (0, 0), (depth, depth))
    painter.setBrush(steel)
    painter.setPen(QtGui.QPen(QtGui.QColor("#0b1115"), 1))
    painter.drawPath(shape)
    painter.setPen(overlay._pen("glow", 210, 0.65))
    painter.drawLine(QtCore.QPointF(5, 0.8), QtCore.QPointF(reach - 2, 0.8))
    painter.drawLine(QtCore.QPointF(0.8, 5), QtCore.QPointF(0.8, reach - 2))
    if depth <= 3:
        return
    radius = depth * 0.18
    for center in ((depth * 0.42, depth * 0.42), (reach - 7, depth * 0.22), (depth * 0.22, reach - 7)):
        bolt = QtCore.QPointF(*center)
        painter.setBrush(overlay._color("border"))
        painter.setPen(QtGui.QPen(QtGui.QColor("#0a1014"), 1.1))
        painter.drawEllipse(bolt, radius, radius)
        painter.setPen(overlay._pen("plate", 255, 0.8))
        painter.drawLine(bolt + QtCore.QPointF(-radius * 0.55, 0), bolt + QtCore.QPointF(radius * 0.55, 0))


def paint_terran_border(overlay, painter, rectangle, *, QtCore, QtGui):
    painter.save()
    depth = _perimeter(painter, rectangle, QtCore=QtCore, QtGui=QtGui)
    steel = _gradient(QtGui, ((0, overlay._color("border")), (0.018, overlay._color("frame")),
                             (0.5, overlay._color("plate")), (0.97, overlay._color("frame")),
                             (1, overlay._color("border"))),
                      (rectangle.left(), rectangle.top()), (rectangle.right(), rectangle.bottom()))
    painter.fillRect(rectangle, steel)
    painter.setBrush(QtCore.Qt.NoBrush)
    painter.setPen(overlay._pen("glow", 190, 0.8))
    painter.drawRect(rectangle.adjusted(0.5, 0.5, -0.5, -0.5))
    painter.setPen(QtGui.QPen(QtGui.QColor("#0a1115"), 1.4))
    painter.drawRect(rectangle.adjusted(depth - 0.7, depth - 0.7, -depth + 0.7, -depth + 0.7))
    for edge in ("top", "bottom", "left", "right"):
        length = _edge(painter, rectangle, edge)
        _steel_tube(overlay, painter, length, depth, QtCore=QtCore, QtGui=QtGui)
        if edge in {"top", "bottom"}:
            _hazard_patch(overlay, painter, length, depth, QtCore=QtCore, QtGui=QtGui)
            lcd_width = min(28.0, length * 0.08)
            lcd = QtCore.QRectF(length * 0.66, depth * 0.12, lcd_width, max(0.7, depth * 0.22))
            painter.fillRect(lcd.adjusted(-1, -0.7, 1, 0.7), QtGui.QColor("#0b150e"))
            for segment in range(5):
                painter.fillRect(QtCore.QRectF(lcd.left() + segment * lcd_width / 5, lcd.top(), lcd_width / 5 - 1, lcd.height()), overlay._color("accent", 220))
            if depth > 3:
                radius = depth * 0.22
                center = QtCore.QPointF(length - 47, depth * 0.36)
                painter.setPen(overlay._pen("plate", 255, 1.6))
                lamp = QtGui.QRadialGradient(center - QtCore.QPointF(radius * 0.3, radius * 0.3), radius * 1.3)
                lamp.setColorAt(0, QtGui.QColor("#ffd6b0"))
                lamp.setColorAt(0.3, QtGui.QColor("#df4532"))
                lamp.setColorAt(1, QtGui.QColor("#490d10"))
                painter.setBrush(lamp)
                painter.drawEllipse(center, radius, radius)
        painter.restore()
    for horizontal, vertical in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        painter.save()
        painter.translate(rectangle.left() if horizontal == 1 else rectangle.right(),
                          rectangle.top() if vertical == 1 else rectangle.bottom())
        painter.scale(horizontal, vertical)
        _terran_corner(overlay, painter, depth, QtCore=QtCore, QtGui=QtGui)
        painter.restore()
    painter.restore()


def _chitin_segment(overlay, painter, length, depth, alternate, *, QtCore, QtGui):
    shell = QtGui.QPainterPath(QtCore.QPointF(-2, depth))
    shell.cubicTo(0, depth * 0.2, length * 0.15, depth * 0.06, length * 0.34, depth * 0.32)
    shell.quadTo(length * 0.51, depth * 0.55, length * 0.66, 0.15)
    shell.cubicTo(length * 0.63, depth * 0.42, length * 0.82, depth * 0.18, length + 3, depth * 0.5)
    shell.lineTo(length, depth)
    shell.closeSubpath()
    material = _gradient(QtGui, ((0, overlay._color("plate")), (0.19, overlay._color("border")),
                                (0.34, overlay._color("frame")), (0.58, QtGui.QColor("#181411")),
                                (0.79, overlay._color("frame")), (1, QtGui.QColor("#080807"))),
                         (0, 0), (depth * 0.3, depth))
    painter.setBrush(material)
    painter.setPen(QtGui.QPen(QtGui.QColor("#080706"), 1.1))
    painter.drawPath(shell)
    spike = QtGui.QPainterPath(QtCore.QPointF(length * 0.38, depth * 0.96))
    spike.cubicTo(length * 0.48, depth * 0.43, length * 0.66, depth * 0.53, length * 0.83, depth * 0.04)
    spike.cubicTo(length * 0.76, depth * 0.61, length * 0.67, depth * 0.68, length * 0.64, depth * 0.98)
    spike.closeSubpath()
    spike_material = _gradient(QtGui, ((0, overlay._color("border")), (0.29, overlay._color("frame")),
                                      (0.53, overlay._color("plate")), (0.8, overlay._color("frame")),
                                      (1, QtGui.QColor("#080706"))),
                               (0, depth * 0.2), (0, depth))
    painter.setBrush(spike_material)
    painter.drawPath(spike)
    spine = QtGui.QPainterPath(QtCore.QPointF(length * 0.42, depth * 0.85))
    spine.cubicTo(length * 0.56, depth * 0.46, length * 0.69, depth * 0.47, length * 0.81, depth * 0.09)
    painter.setPen(overlay._pen("glow", 165, 0.65))
    painter.setBrush(QtCore.Qt.NoBrush)
    painter.drawPath(spine)
    ridge = QtGui.QPainterPath(QtCore.QPointF(1, depth * 0.65))
    ridge.cubicTo(length * 0.1, depth * 0.15, length * 0.29, depth * 0.51, length * 0.4, depth * 0.48)
    ridge.quadTo(length * 0.54, depth * 0.44, length * 0.64, depth * 0.1)
    painter.setBrush(QtCore.Qt.NoBrush)
    painter.setPen(overlay._pen("glow", 145 if alternate else 110, 0.6))
    painter.drawPath(ridge)
    fissure = QtGui.QPainterPath(QtCore.QPointF(length * 0.07, depth * 0.87))
    fissure.cubicTo(length * 0.24, depth * 0.57, length * 0.34, depth * 0.98, length * 0.53, depth * 0.71)
    fissure.quadTo(length * 0.69, depth * 0.57, length * 0.87, depth * 0.87)
    painter.setPen(QtGui.QPen(QtGui.QColor("#4b1b0e"), 2 if depth > 3 else 0.9))
    painter.drawPath(fissure)
    painter.setPen(overlay._pen("accent", 185 if alternate else 120, 0.7 if depth > 3 else 0.4))
    painter.drawPath(fissure)
    if depth > 3:
        branch = QtGui.QPainterPath(QtCore.QPointF(length * 0.54, depth * 0.72))
        branch.quadTo(length * 0.48, depth * 0.5, length * 0.43, depth * 0.62)
        painter.setPen(overlay._pen("accent", 145, 0.6))
        painter.drawPath(branch)


def _bone_corner(overlay, painter, depth, *, QtCore, QtGui):
    reach = depth * 3.5
    horn = QtGui.QPainterPath(QtCore.QPointF(0, reach))
    horn.cubicTo(depth * 0.58, reach * 0.75, depth * 0.12, depth * 1.5, depth * 0.9, depth * 0.8)
    horn.cubicTo(depth * 1.5, depth * 0.11, reach * 0.7, depth * 0.64, reach, 0)
    horn.cubicTo(reach * 0.72, depth * 0.02, depth * 1.3, -depth * 0.1, depth * 0.3, depth * 0.24)
    horn.cubicTo(-depth * 0.1, depth * 1.1, depth * 0.02, reach * 0.7, 0, reach)
    bone = _gradient(QtGui, ((0, QtGui.QColor("#d1b28a")), (0.18, overlay._color("border")),
                            (0.42, overlay._color("frame")), (0.66, overlay._color("plate")),
                            (1, overlay._color("border"))), (0, 0), (depth, depth))
    painter.setBrush(bone)
    painter.setPen(QtGui.QPen(QtGui.QColor("#090807"), 1.2))
    painter.drawPath(horn)
    vein = QtGui.QPainterPath(QtCore.QPointF(depth * 0.2, reach * 0.72))
    vein.cubicTo(depth * 0.4, depth * 0.9, depth * 0.9, depth * 0.4, reach * 0.72, depth * 0.2)
    painter.setBrush(QtCore.Qt.NoBrush)
    painter.setPen(overlay._pen("glow", 135, 0.6))
    painter.drawPath(vein)


def paint_zerg_border(overlay, painter, rectangle, *, QtCore, QtGui):
    painter.save()
    depth = _perimeter(painter, rectangle, QtCore=QtCore, QtGui=QtGui)
    painter.fillRect(rectangle, overlay._color("plate"))
    for edge in ("top", "bottom", "left", "right"):
        length = _edge(painter, rectangle, edge)
        segment_length = min(76.0, max(30.0, length / max(1, round(length / 64))))
        position = -segment_length * 0.25
        index = 0
        while position < length:
            painter.save()
            painter.translate(position, 0)
            _chitin_segment(overlay, painter, segment_length, depth, index % 2, QtCore=QtCore, QtGui=QtGui)
            painter.restore()
            position += segment_length * 0.87
            index += 1
        painter.restore()
    for horizontal, vertical in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        painter.save()
        painter.translate(rectangle.left() if horizontal == 1 else rectangle.right(),
                          rectangle.top() if vertical == 1 else rectangle.bottom())
        painter.scale(horizontal, vertical)
        _bone_corner(overlay, painter, depth, QtCore=QtCore, QtGui=QtGui)
        painter.restore()
    painter.restore()
