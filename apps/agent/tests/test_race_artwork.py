from __future__ import annotations

import ast
from pathlib import Path

import pytest

from sc2tools_agent.ui import race_artwork
from sc2tools_agent.ui.race_artwork import COMPACT_CORNER, NORMAL_CORNER, ZERG_NORMAL_CORNER, frame_pieces
from tests._gui_offscreen import run_gui_check


def test_artwork_import_is_qt_free_and_has_no_global_image_reads():
    tree = ast.parse(Path(race_artwork.__file__).read_text())
    imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert not any("PySide" in ast.unparse(node) or "PyQt" in ast.unparse(node) for node in imports)
    globals_source = "\n".join(ast.unparse(node) for node in tree.body
                               if not isinstance(node, (ast.FunctionDef, ast.ClassDef)))
    assert not any(call in globals_source for call in ("QImage(", ".read_", ".open(", ".resolve("))


@pytest.mark.parametrize("source_size", [(1024, 1024), (1254, 1254), (960, 1280)])
@pytest.mark.parametrize("target_size", [(280, 68), (340, 78), (360, 40), (420, 44), (520, 480), (1024, 800),
                                         (1920, 1080), (3840, 2160)])
def test_all_sizes_keep_corners_and_center_ornaments_uniform_without_painting_the_center(source_size, target_size):
    source_width, source_height = source_size
    target_width, target_height = target_size
    pieces = frame_pieces(source_width, source_height, target_width, target_height)
    assert len(pieces) == 16
    corner = COMPACT_CORNER if target_height < 140 else NORMAL_CORNER
    scale = corner / pieces[0].source[2]
    assert pieces[0].target == (0, 0, corner, corner)
    for piece in pieces:
        source_horizontal, source_vertical, source_span, source_depth = piece.source
        horizontal, vertical, span, depth = piece.target
        assert span > 0 and depth > 0 and source_span > 0 and source_depth > 0
        assert 0 <= source_horizontal <= source_width - source_span
        assert 0 <= source_vertical <= source_height - source_depth
        assert 0 <= horizontal <= target_width - span
        assert 0 <= vertical <= target_height - depth
        assert not (horizontal < target_width / 2 < horizontal + span
                    and vertical < target_height / 2 < vertical + depth)
        if source_horizontal in (0, source_width - source_span):
            assert span / source_span == pytest.approx(scale)
        if source_vertical in (0, source_height - source_depth):
            assert depth / source_depth == pytest.approx(scale)
    for ornament in (pieces[2], pieces[7], pieces[8], pieces[13]):
        assert ornament.target[2] / ornament.source[2] == pytest.approx(scale)
        assert ornament.target[3] / ornament.source[3] == pytest.approx(scale)
    area = sum(piece.target[2] * piece.target[3] for piece in pieces)
    assert area == pytest.approx(target_width * target_height
                                 - (target_width - 2 * corner) * (target_height - 2 * corner))
    for index, first in enumerate(pieces):
        horizontal, vertical, span, depth = first.target
        for second in pieces[index + 1:]:
            other_horizontal, other_vertical, other_span, other_depth = second.target
            overlap_width = min(horizontal + span, other_horizontal + other_span) - max(horizontal, other_horizontal)
            overlap_height = min(vertical + depth, other_vertical + other_depth) - max(vertical, other_vertical)
            assert overlap_width <= 1e-9 or overlap_height <= 1e-9


@pytest.mark.parametrize("dimensions", [(0, 1024, 340, 78), (1024, -1, 520, 480),
                                        (1024, 1024, float("nan"), 480), (1024, 1024, 520, float("inf")),
                                        (None, 1024, 520, 480)])
def test_invalid_dimensions_do_not_produce_paint_commands(dimensions):
    assert frame_pieces(*dimensions) == ()


def test_tiny_targets_never_cross_or_create_negative_slices():
    for width, height in ((1, 1), (12, 9), (48, 32)):
        for piece in frame_pieces(1024, 1024, width, height):
            horizontal, vertical, span, depth = piece.target
            assert span > 0 and depth > 0
            assert 0 <= horizontal <= width - span + 1e-9
            assert 0 <= vertical <= height - depth + 1e-9


def test_zerg_uses_smaller_normal_corners_without_changing_compact_or_other_skins():
    for target_width, target_height in ((340, 78), (520, 480), (1024, 800), (1920, 1080)):
        original = frame_pieces(1254, 1254, target_width, target_height)
        zerg = frame_pieces(1254, 1254, target_width, target_height, normal_corner=ZERG_NORMAL_CORNER)
        expected = COMPACT_CORNER if target_height < 140 else ZERG_NORMAL_CORNER
        assert zerg[0].target == (0, 0, expected, expected)
        if target_height < 140:
            assert zerg == original
        else:
            assert original[0].target[2] == NORMAL_CORNER


def test_loader_caches_valid_missing_corrupt_and_opaque_assets_once_without_loading_default(tmp_path):
    run_gui_check(tmp_path, '''
from types import SimpleNamespace
from sc2tools_agent.ui.race_artwork import create_race_artwork
root = base / "artwork"
root.mkdir()
image = QtGui.QImage(256, 256, QtGui.QImage.Format_ARGB32_Premultiplied)
image.fill(QtCore.Qt.transparent)
painter = QtGui.QPainter(image)
painter.fillRect(0, 0, 256, 20, QtGui.QColor("#e4bc67"))
painter.end()
assert image.save(str(root / "protoss-frame.png"))
(root / "terran-frame.png").write_bytes(b"not a PNG")
calls = []

class CountingImage(QtGui.QImage):
    def __init__(self, filename):
        calls.append(filename)
        super().__init__(filename)

module = SimpleNamespace(QImage=CountingImage, QPainter=QtGui.QPainter)
first = create_race_artwork(QtCore=QtCore, QtGui=module, asset_root=root)
second = create_race_artwork(QtCore=QtCore, QtGui=module, asset_root=root)
for skin in ("default", "../protoss", "unknown", None, {}, []):
    assert first.image_for_skin(skin) is None
assert calls == []
original = first.image_for_skin("protoss")
assert original is not None and original.devicePixelRatio() == 1
assert second.image_for_skin("protoss") is original
for skin in ("terran", "zerg"):
    assert first.image_for_skin(skin) is None
    assert second.image_for_skin(skin) is None
assert len(calls) == 3
opaque_root = base / "opaque"
opaque_root.mkdir()
image.fill(QtGui.QColor("#e4bc67"))
assert image.save(str(opaque_root / "protoss-frame.png"))
opaque = create_race_artwork(QtCore=QtCore, QtGui=module, asset_root=opaque_root)
assert opaque.image_for_skin("protoss") is None
assert opaque.image_for_skin("protoss") is None
assert len(calls) == 4
''')


def test_raster_paint_is_crisp_at_high_dpi_restores_state_and_keeps_the_interior_clear(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.race_artwork import create_race_artwork
root = base / "artwork"
root.mkdir()
source = QtGui.QImage(1000, 1000, QtGui.QImage.Format_ARGB32_Premultiplied)
source.fill(QtCore.Qt.transparent)
painter = QtGui.QPainter(source)
for rectangle in ((0, 0, 1000, 80), (0, 920, 1000, 80), (0, 0, 80, 1000), (920, 0, 80, 1000)):
    painter.fillRect(QtCore.QRect(*rectangle), QtGui.QColor("#e4bc67"))
painter.fillRect(0, 0, 180, 180, QtGui.QColor("#3dd8f0"))
painter.fillRect(440, 0, 120, 140, QtGui.QColor("#3dd8f0"))
painter.end()
assert source.save(str(root / "protoss-frame.png"))
artwork = create_race_artwork(QtCore=QtCore, QtGui=QtGui, asset_root=root)
for width, height in ((340, 78), (520, 480), (1024, 800), (1920, 1080)):
    for ratio in (1, 2):
        image = QtGui.QImage(width * ratio, height * ratio, QtGui.QImage.Format_ARGB32_Premultiplied)
        image.setDevicePixelRatio(ratio)
        image.fill(QtCore.Qt.transparent)
        painter = QtGui.QPainter(image)
        painter.setOpacity(0.87)
        painter.setRenderHint(QtGui.QPainter.Antialiasing)
        painter.setClipRect(QtCore.QRectF(1, 1, width - 2, height - 2))
        original_transform = painter.transform()
        original_clip = painter.clipPath()
        original_hints = painter.renderHints()
        rectangle = QtCore.QRectF(2, 2, width - 4, height - 4)
        assert artwork.paint(painter, "protoss", rectangle)
        assert painter.transform() == original_transform
        assert painter.clipPath() == original_clip
        assert painter.renderHints() == original_hints
        assert painter.opacity() == 0.87
        painter.end()
        assert image.pixelColor(width * ratio // 2, height * ratio // 2).alpha() == 0
        assert image.pixelColor(3 * ratio, 3 * ratio).alpha() > 0
        assert image.pixelColor(width * ratio // 2, 4 * ratio).alpha() > 0
        assert image.pixelColor(0, height * ratio // 2).alpha() == 0
        corner = 10 if height < 140 else 28
        for horizontal, vertical in ((2 + corner, height // 2), (width // 2, 2 + corner),
                                     (width - 3 - corner, height // 2), (width // 2, height - 3 - corner)):
            assert image.pixelColor(horizontal * ratio, vertical * ratio).alpha() == 0
''')


def test_overlay_uses_raster_artwork_and_retains_procedural_fallback_without_an_idle_timer(tmp_path):
    run_gui_check(tmp_path, '''
from types import SimpleNamespace
from sc2tools_agent.ui import race_visuals
calls = []
available = [True]

def paint_artwork(painter, skin, rectangle):
    calls.append(skin)
    if available[0]:
        painter.fillRect(QtCore.QRectF(rectangle.left(), rectangle.top(), 18, 3), QtGui.QColor("#eb1dba"))
    return available[0]

race_visuals.create_race_artwork = lambda **kwargs: SimpleNamespace(paint=paint_artwork)
window = QtWidgets.QWidget()
window.resize(520, 480)
window.show()
app.processEvents()
effects = race_visuals.create_race_effects(window, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
effects.apply_skin("protoss")
app.processEvents()

def render():
    image = QtGui.QImage(window.size(), QtGui.QImage.Format_ARGB32_Premultiplied)
    image.fill(QtCore.Qt.transparent)
    painter = QtGui.QPainter(image)
    effects.overlay.render(painter, QtCore.QPoint(), QtGui.QRegion(), QtWidgets.QWidget.DrawChildren)
    painter.end()
    return image

image = render()
assert calls and image.pixelColor(4, 3).name() == "#eb1dba"
assert image.pixelColor(200, 3).alpha() == 0
assert not effects.timer.isActive()
available[0] = False
image = render()
assert image.pixelColor(200, 3).alpha() > 0
assert image.pixelColor(260, 240).alpha() == 0
effects.apply_skin("default")
assert not effects.overlay.isVisible() and not effects.timer.isActive()
effects.shutdown()
window.close()
''')


@pytest.mark.parametrize("skin", ["protoss", "terran", "zerg"])
def test_packaged_artwork_loads_and_fits_every_approved_size_without_center_paint(tmp_path, skin):
    run_gui_check(tmp_path, f'''
from sc2tools_agent.ui.race_artwork import create_race_artwork
artwork = create_race_artwork(QtCore=QtCore, QtGui=QtGui)
skin = {skin!r}
source = artwork.image_for_skin(skin)
assert source is not None, skin + " raster artwork is missing or invalid"
assert source.hasAlphaChannel()
assert source.pixelColor(source.width() // 2, source.height() // 2).alpha() == 0
for width, height in ((340, 78), (520, 480), (1024, 800), (1920, 1080)):
    image = QtGui.QImage(width, height, QtGui.QImage.Format_ARGB32_Premultiplied)
    image.fill(QtCore.Qt.transparent)
    painter = QtGui.QPainter(image)
    assert artwork.paint(painter, skin, QtCore.QRectF(2, 2, width - 5, height - 5))
    painter.end()
    assert image.save(str(base / (skin + "-" + str(width) + ".png")))
    corner = 10 if height < 140 else 28
    assert any(image.pixelColor(horizontal, vertical).alpha() > 0
               for vertical in range(2, 2 + corner)
               for horizontal in range(2, width - 3))
    for horizontal, vertical in ((width // 2, height // 2), (width // 4, height // 4),
                                 (width // 2, 2 + corner), (2 + corner, height // 2),
                                 (width - 4 - corner, height // 2), (width // 2, height - 4 - corner)):
        assert image.pixelColor(horizontal, vertical).alpha() == 0, (skin, width, horizontal, vertical)
''')


def test_zerg_artwork_clears_the_standard_header_name_mmr_and_controls(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.race_artwork import create_race_artwork
artwork = create_race_artwork(QtCore=QtCore, QtGui=QtGui)
image = QtGui.QImage(520, 450, QtGui.QImage.Format_ARGB32_Premultiplied)
image.fill(QtCore.Qt.transparent)
painter = QtGui.QPainter(image)
assert artwork.paint(painter, "zerg", QtCore.QRectF(2, 2, 515, 445))
painter.end()
for vertical in range(18, 41):
    for horizontal in range(200, 450):
        assert image.pixelColor(horizontal, vertical).alpha() == 0, (horizontal, vertical)
assert any(image.pixelColor(horizontal, vertical).alpha() > 0
           for vertical in range(2, 18) for horizontal in range(200, 450))
''')
