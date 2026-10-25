from __future__ import annotations

import ast
from pathlib import Path
import re

import pytest

from sc2tools_agent.ui import race_materials, theme
from tests._gui_offscreen import run_gui_check


def test_material_module_has_no_qt_import_and_keeps_readable_dark_surfaces():
    imports = [node for node in ast.walk(ast.parse(Path(race_materials.__file__).read_text()))
               if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert not any("PySide" in ast.unparse(node) or "PyQt" in ast.unparse(node) for node in imports)
    for palette in (race_materials.TERRAN_PALETTE, race_materials.ZERG_PALETTE):
        assert set(palette) == {"frame", "border", "accent", "plate", "surface", "glow"}
        assert palette["surface"] == theme.SURFACE
        assert all(re.fullmatch(r"#[0-9a-f]{6}", value) for value in palette.values())
    terran = race_materials.TERRAN_PALETTE["accent"]
    zerg = race_materials.ZERG_PALETTE["accent"]
    assert int(terran[3:5], 16) > int(terran[1:3], 16) > int(terran[5:7], 16)
    assert int(zerg[1:3], 16) > int(zerg[3:5], 16) > int(zerg[5:7], 16)
    terran_frame = race_materials.TERRAN_PALETTE["frame"]
    zerg_frame = race_materials.ZERG_PALETTE["frame"]
    assert int(terran_frame[5:7], 16) > int(terran_frame[3:5], 16) > int(terran_frame[1:3], 16)
    assert int(zerg_frame[1:3], 16) > int(zerg_frame[5:7], 16) > int(zerg_frame[3:5], 16)


@pytest.mark.parametrize("skin", ["terran", "zerg"])
@pytest.mark.parametrize("size", [(340, 78), (520, 480)])
def test_materials_have_depth_without_painting_content_and_restore_painter_state(tmp_path, skin, size):
    run_gui_check(tmp_path, f'''
from sc2tools_agent.ui import race_materials
skin = {skin!r}
width, height = {size!r}
palette = getattr(race_materials, skin.upper() + "_PALETTE")
paint = getattr(race_materials, "paint_" + skin + "_border")

class Material:
    def _color(self, key, alpha=255):
        color = QtGui.QColor(palette[key])
        color.setAlpha(alpha)
        return color

    def _pen(self, key, alpha=255, width=1.3):
        pen = QtGui.QPen(self._color(key, alpha), width)
        pen.setCapStyle(QtCore.Qt.RoundCap)
        return pen

def render():
    image = QtGui.QImage(width, height, QtGui.QImage.Format_ARGB32_Premultiplied)
    image.fill(QtCore.Qt.transparent)
    painter = QtGui.QPainter(image)
    painter.setRenderHint(QtGui.QPainter.Antialiasing)
    painter.setPen(QtGui.QPen(QtGui.QColor("#123456"), 2.3))
    painter.setBrush(QtGui.QColor("#abcdef"))
    painter.setOpacity(0.93)
    painter.setClipRect(QtCore.QRect(1, 1, width - 2, height - 2))
    original_pen = QtGui.QPen(painter.pen())
    original_brush = QtGui.QBrush(painter.brush())
    original_transform = painter.transform()
    original_clip = painter.clipPath()
    original_opacity = painter.opacity()
    paint(Material(), painter, QtCore.QRectF(2, 2, width - 4, height - 4), QtCore=QtCore, QtGui=QtGui)
    assert painter.pen() == original_pen
    assert painter.brush() == original_brush
    assert painter.transform() == original_transform
    assert painter.clipPath() == original_clip
    assert painter.opacity() == original_opacity
    painter.end()
    return image

image = render()
assert image == render()
assert image.save(str(base / (skin + "-" + str(width) + ".png")))
depth = 3 if height <= 100 else 13
colors = set()
red_lamps = green_lcd = ember = 0
for vertical in range(height):
    for horizontal in range(width):
        color = image.pixelColor(horizontal, vertical)
        if 2 + depth <= horizontal < width - 2 - depth and 2 + depth <= vertical < height - 2 - depth:
            assert color.alpha() == 0, (horizontal, vertical, color.name())
        if horizontal < 2 or horizontal >= width - 2 or vertical < 2 or vertical >= height - 2:
            assert color.alpha() == 0
        if color.alpha() > 150:
            colors.add(color.rgba())
            red_lamps += color.red() > color.green() * 1.5 and color.red() > color.blue() * 1.5
            green_lcd += color.green() > color.red() * 1.15 and color.green() > color.blue() * 1.2
            ember += color.red() > color.green() * 1.4 and color.green() > color.blue() * 1.3
assert len(colors) > (45 if height <= 100 else 150), len(colors)
if skin == "terran":
    assert green_lcd > 8
    if height > 100:
        assert red_lamps > 8
else:
    assert ember > 20
''')
