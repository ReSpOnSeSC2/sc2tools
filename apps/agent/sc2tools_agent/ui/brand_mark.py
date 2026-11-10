"""The window's brand mark: one restrained motif per skin, painted in its accent.

Each mark is a ring around a core, both in one outline: a circle for the
default skin, a crystal for Protoss, a hexagon for Terran and a teardrop for
Zerg. The outlines are Qt-free point lists on a unit square; painting is lazy.
"""
from __future__ import annotations

from math import cos, pi, sin

from . import theme

MARK_SIZE = 20
# The ring's inner edge and the core, as fractions of the outline.
RING_INNER = 0.6
CORE = 0.3
_STEPS = 48


def _polygon(corners, rotation):
    return tuple((0.5 + 0.48 * sin(rotation + 2 * pi * index / corners),
                  0.5 - 0.48 * cos(rotation + 2 * pi * index / corners)) for index in range(corners))


def _teardrop():
    # Point up, round below: x = sin t * sin(t / 2), y = -cos t.
    return tuple((0.5 + 0.44 * sin(t) * sin(t / 2), 0.52 - 0.46 * cos(t))
                 for t in (2 * pi * index / _STEPS for index in range(_STEPS)))


MOTIFS = {
    "default": _polygon(_STEPS, 0.0),
    "protoss": ((0.5, 0.02), (0.8, 0.5), (0.5, 0.98), (0.2, 0.5)),
    "terran": _polygon(6, 0.0),
    "zerg": _teardrop(),
}


def motif(skin):
    """The unit-square outline of ``skin``'s mark; an unknown skin draws the default."""
    return MOTIFS.get(skin, MOTIFS["default"])


def scaled(outline, factor):
    """``outline`` shrunk towards the square's centre by ``factor``."""
    return tuple((0.5 + (x - 0.5) * factor, 0.5 + (y - 0.5) * factor) for x, y in outline)


def create_brand_mark(*, QtCore, QtGui, QtWidgets, parent=None):
    class BrandMark(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("agentBrandMark")
            self.setFixedSize(MARK_SIZE, MARK_SIZE)
            self.setFocusPolicy(QtCore.Qt.NoFocus)
            self.skin = "default"

        def set_skin(self, skin):
            self.skin = skin if skin in theme.SKINS else "default"
            self.update()

        def paintEvent(self, _event):
            painter = QtGui.QPainter(self)
            painter.setRenderHint(QtGui.QPainter.Antialiasing)
            path = QtGui.QPainterPath()
            path.setFillRule(QtCore.Qt.OddEvenFill)
            outline = motif(self.skin)
            for factor in (1.0, RING_INNER, CORE):
                points = [QtCore.QPointF(x * self.width(), y * self.height()) for x, y in scaled(outline, factor)]
                path.addPolygon(QtGui.QPolygonF(points))
                path.closeSubpath()
            painter.fillPath(path, QtGui.QColor(theme.SKINS[self.skin].accent))
            painter.end()

    return BrandMark()
