"""Responsive perimeter rendering of optional, locally packaged race artwork."""
from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from pathlib import Path


SOURCE_CORNER_FRACTION = 0.22
SOURCE_ORNAMENT_FRACTION = 0.16
NORMAL_CORNER = 28.0
COMPACT_CORNER = 10.0
ZERG_NORMAL_CORNER = 18.0
_SKINS = frozenset(("protoss", "terran", "zerg"))
_IMAGE_CACHE = {}


@dataclass(frozen=True)
class FramePiece:
    source: tuple[float, float, float, float]
    target: tuple[float, float, float, float]


def frame_pieces(source_width, source_height, target_width, target_height, *, normal_corner=NORMAL_CORNER):
    dimensions = (source_width, source_height, target_width, target_height, normal_corner)
    if not all(isinstance(value, (int, float)) and isfinite(value) and value > 0 for value in dimensions):
        return ()
    source_corner = min(source_width / 2, source_height / 2,
                        max(1.0, round(min(source_width, source_height) * SOURCE_CORNER_FRACTION)))
    source_ornament = min(source_width - 2 * source_corner, source_height - 2 * source_corner,
                          max(1.0, round(min(source_width, source_height) * SOURCE_ORNAMENT_FRACTION)))
    ornament_ratio = source_ornament / source_corner
    target_corner = min(COMPACT_CORNER if target_height < 140 else normal_corner,
                        target_width / (2 + ornament_ratio), target_height / (2 + ornament_ratio))
    target_ornament = source_ornament * target_corner / source_corner

    def coordinates(extent, corner, ornament):
        return (0.0, corner, (extent - ornament) / 2,
                (extent + ornament) / 2, extent - corner, float(extent))

    source_columns = coordinates(source_width, source_corner, source_ornament)
    source_rows = coordinates(source_height, source_corner, source_ornament)
    target_columns = coordinates(target_width, target_corner, target_ornament)
    target_rows = coordinates(target_height, target_corner, target_ornament)
    pieces = []
    for row in range(5):
        for column in range(5):
            if row not in (0, 4) and column not in (0, 4):
                continue
            source = (source_columns[column], source_rows[row],
                      source_columns[column + 1] - source_columns[column],
                      source_rows[row + 1] - source_rows[row])
            target = (target_columns[column], target_rows[row],
                      target_columns[column + 1] - target_columns[column],
                      target_rows[row + 1] - target_rows[row])
            if source[2] > 0 and source[3] > 0 and target[2] > 0 and target[3] > 0:
                pieces.append(FramePiece(source, target))
    return tuple(pieces)


def create_race_artwork(*, QtCore, QtGui, asset_root=None, compact_bezel=False):
    root = (Path(asset_root) if asset_root is not None else Path(__file__).parent / "assets" / "races").resolve()

    class RaceArtwork:
        def image_for_skin(self, skin):
            if not isinstance(skin, str) or skin not in _SKINS:
                return None
            filename = root / (skin + "-frame.png")
            cache_key = (str(filename), QtGui.QImage)
            if cache_key not in _IMAGE_CACHE:
                image = QtGui.QImage(str(filename))
                valid = (not image.isNull() and min(image.width(), image.height()) >= 16
                         and image.hasAlphaChannel()
                         and image.pixelColor(image.width() // 2, image.height() // 2).alpha() == 0)
                if valid:
                    image = image.convertToFormat(QtGui.QImage.Format_ARGB32_Premultiplied)
                    image.setDevicePixelRatio(1.0)
                _IMAGE_CACHE[cache_key] = image if valid else None
            return _IMAGE_CACHE[cache_key]

        def paint(self, painter, skin, rectangle):
            image = self.image_for_skin(skin)
            if image is None:
                return False
            pieces = frame_pieces(image.width(), image.height(), rectangle.width(), rectangle.height(),
                                  normal_corner=COMPACT_CORNER if compact_bezel else
                                  ZERG_NORMAL_CORNER if skin == "zerg" else NORMAL_CORNER)
            if not pieces:
                return False
            painter.save()
            try:
                painter.setRenderHint(QtGui.QPainter.SmoothPixmapTransform)
                painter.setClipRect(rectangle, QtCore.Qt.IntersectClip)
                for piece in pieces:
                    target = QtCore.QRectF(*piece.target).translated(rectangle.topLeft())
                    painter.drawImage(target, image, QtCore.QRectF(*piece.source))
            finally:
                painter.restore()
            return True

    return RaceArtwork()
