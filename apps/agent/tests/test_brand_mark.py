import ast
from pathlib import Path

from sc2tools_agent.ui import brand_mark, theme
from sc2tools_agent.ui.brand_mark import motif, scaled
from tests._gui_offscreen import run_gui_check


def test_the_mark_module_is_qt_free():
    imports = [ast.unparse(node) for node in ast.walk(ast.parse(Path(brand_mark.__file__).read_text(encoding="utf-8")))
               if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert not any("PySide" in line or "Qt" in line for line in imports)


def test_each_skin_has_its_own_motif_inside_the_square_and_an_unknown_skin_draws_the_default():
    outlines = {name: motif(name) for name in theme.SKINS}
    assert len(set(outlines.values())) == len(theme.SKINS)
    for outline in outlines.values():
        assert len(outline) >= 4 and all(0 <= x <= 1 and 0 <= y <= 1 for x, y in outline)
    assert motif("unknown") == motif("default")
    assert scaled(((0.0, 0.0), (1.0, 1.0)), 0.5) == ((0.25, 0.25), (0.75, 0.75))


def test_the_mark_paints_a_ring_around_a_core_in_the_skin_accent(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.brand_mark import MARK_SIZE, create_brand_mark
mark = create_brand_mark(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
assert mark.size() == QtCore.QSize(MARK_SIZE, MARK_SIZE) and mark.focusPolicy() == QtCore.Qt.NoFocus
masks = []
centre = MARK_SIZE // 2
for skin in theme.SKINS:
    mark.set_skin(skin)
    image = mark.grab().toImage()
    accent = theme.SKINS[skin].accent
    column = [image.pixelColor(centre, row).name() for row in range(MARK_SIZE)]
    assert column[centre] == accent and column[3] == accent, (skin, column)
    assert any(name != accent for name in column[4:8]), (skin, column)
    masks.append(frozenset((x, y) for x in range(MARK_SIZE) for y in range(MARK_SIZE)
                           if image.pixelColor(x, y).name() == accent))
assert len(set(masks)) == len(theme.SKINS)
mark.set_skin("bogus")
assert mark.skin == "default"
''')
