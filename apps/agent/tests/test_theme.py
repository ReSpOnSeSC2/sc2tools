import ast
from pathlib import Path
from xml.etree import ElementTree

import pytest

from sc2tools_agent.ui import palette, theme


@pytest.mark.parametrize("name", [
    "BG", "SURFACE", "ELEVATED", "SUBTLE", "TEXT", "TEXT_MUTED", "TEXT_DIM",
    "ACCENT", "ACCENT_HOVER", "ACCENT_CYAN", "BORDER", "BORDER_STRONG",
    "BUTTON", "BUTTON_HOVER", "BUTTON_CHECKED", "FOCUS",
])
def test_public_theme_colors_are_valid_hex(name):
    value = getattr(theme, name)
    assert value.startswith("#") and len(value) == 7
    assert int(value[1:], 16) >= 0


def test_status_tones_keep_existing_semantics():
    assert theme.SUCCESS == palette.GREEN
    assert theme.WARNING == palette.AMBER
    assert theme.DANGER == palette.RED
    assert theme.INFO == palette.CYAN


def test_theme_module_does_not_import_qt():
    source = ast.parse(Path(theme.__file__).read_text(encoding="utf-8"))
    imports = [
        node.module for node in ast.walk(source) if isinstance(node, ast.ImportFrom)
    ] + [
        alias.name for node in ast.walk(source) if isinstance(node, ast.Import) for alias in node.names
    ]
    assert all("PySide" not in name and "Qt" not in name for name in imports if name)


@pytest.mark.parametrize("selector", [
    "QFrame#agentFrame", 'QFrame#agentFrame[companion="true"]',
    "QFrame#agentSidebar", "QFrame#agentDisplay", 'QFrame#agentDisplay[companion="true"]',
    "QWidget#agentPageToolbar", "QLabel#agentBrand", "QLabel#agentEdition",
    "QPushButton#navItem:checked:focus", "QPushButton#primary:disabled",
    "QTableView", "QTreeWidget", "QListWidget", "QTabBar::tab:selected",
    "QMenu::item:selected", "QDialogButtonBox", "QToolTip",
    "QToolButton#studioDisclosureToggle", 'QLabel#studioBadge[tone="live"]',
])
def test_shared_styles_cover_existing_and_companion_shell_surfaces(selector):
    assert selector in theme.STYLE


def test_stylesheet_contains_resolved_tokens_and_balanced_rules():
    assert theme.CONSOLE_GRADIENT in theme.STYLE
    assert theme.FOCUS in theme.STYLE
    assert theme.STYLE.count("{") == theme.STYLE.count("}")
    assert "{BG}" not in theme.STYLE
    assert "QLabel, QCheckBox, QRadioButton { background: transparent; }" in theme.STYLE


def test_plain_containers_are_transparent_and_window_surfaces_are_explicit():
    base_rule = theme.STYLE.split("}", 1)[0]
    assert "background: transparent;" in base_rule
    assert "QMainWindow, QWidget#agentRoot { background: " + theme.BG in theme.STYLE
    assert "QDialog, QMessageBox, QFileDialog, QInputDialog { background: " + theme.SURFACE in theme.STYLE
    assert "QWidget#companionPanel, QWidget#ghostPanel { background: " + theme.SURFACE in theme.STYLE
    assert "QWidget#checkinWindow { background: transparent; }" in theme.STYLE


def test_small_help_buttons_do_not_inherit_control_padding():
    help_rule = theme.STYLE.split("QToolButton#helpLink {", 1)[1].split("}", 1)[0]
    assert "padding: 0;" in help_rule
    assert "min-width: 0;" in help_rule
    assert "min-height: 0;" in help_rule


@pytest.mark.parametrize("name", ["check", "dash", "radio-dot", "chevron-down", "chevron-up"])
def test_control_glyphs_are_local_valid_svg_assets_used_by_the_theme(name):
    path = Path(theme.CONTROL_ICONS[name])
    assert path.is_absolute() and path.is_file()
    root = ElementTree.fromstring(path.read_text(encoding="utf-8"))
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert root.attrib["viewBox"] == "0 0 16 16"
    assert f'url("{path.as_posix()}")' in theme.STYLE


def test_control_glyph_directory_is_included_in_the_frozen_bundle():
    spec = Path(theme.__file__).resolve().parents[2] / "packaging" / "sc2tools_agent.spec"
    source = spec.read_text(encoding="utf-8")
    assert 'CONTROL_ICONS = ICON_DIR / "assets" / "controls"' in source
    assert 'DATAS.append((str(CONTROL_ICONS), "sc2tools_agent/ui/assets/controls"))' in source


def test_race_artwork_directory_is_included_in_the_frozen_bundle():
    spec = Path(theme.__file__).resolve().parents[2] / "packaging" / "sc2tools_agent.spec"
    source = spec.read_text(encoding="utf-8")
    assert 'RACE_ARTWORK = ICON_DIR / "assets" / "races"' in source
    assert 'DATAS.append((str(RACE_ARTWORK), "sc2tools_agent/ui/assets/races"))' in source


def test_checked_controls_paint_distinct_glyphs_and_arrows(tmp_path):
    from tests._gui_offscreen import run_gui_check

    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        messages = []
        QtCore.qInstallMessageHandler(lambda kind, context, message: messages.append(message))
        app.setStyleSheet(theme.STYLE)
        surface = QtWidgets.QFrame()
        surface.setObjectName("agentDisplay")
        layout = QtWidgets.QVBoxLayout(surface)
        checkbox = QtWidgets.QCheckBox("Show scouting")
        radio = QtWidgets.QRadioButton("Selected mode")
        combo = QtWidgets.QComboBox()
        combo.addItems(["Standard", "Detailed"])
        spin = QtWidgets.QSpinBox()
        for widget in (checkbox, radio, combo, spin):
            layout.addWidget(widget)
        surface.resize(320, 180)
        surface.show()
        app.processEvents()

        def indicator_image(widget):
            option = QtWidgets.QStyleOptionButton()
            widget.initStyleOption(option)
            element = QtWidgets.QStyle.SE_CheckBoxIndicator if widget is checkbox else QtWidgets.QStyle.SE_RadioButtonIndicator
            rect = widget.style().subElementRect(element, option, widget)
            return widget.grab(rect).toImage().convertToFormat(QtGui.QImage.Format_ARGB32)

        def count_pixels(image, predicate):
            return sum(predicate(image.pixelColor(column, row))
                       for row in range(image.height()) for column in range(image.width()))

        unchecked = indicator_image(checkbox)
        checkbox.setChecked(True)
        radio.setChecked(True)
        app.processEvents()
        checked = indicator_image(checkbox)
        selected = indicator_image(radio)
        assert checked != unchecked
        dark_glyph = lambda color: color.name() == "#241134"
        assert count_pixels(checked, dark_glyph) >= 12
        assert count_pixels(unchecked, dark_glyph) == 0
        assert count_pixels(selected, dark_glyph) >= 12
        assert count_pixels(checked, lambda color: color.name() == theme.ACCENT) >= 20
        checkbox.setTristate(True)
        checkbox.setCheckState(QtCore.Qt.PartiallyChecked)
        app.processEvents()
        partial = indicator_image(checkbox)
        assert count_pixels(partial, lambda color: color.red() > 200 and color.green() > 200 and color.blue() > 200) >= 8

        combo_option = QtWidgets.QStyleOptionComboBox()
        combo.initStyleOption(combo_option)
        arrow_rect = combo.style().subControlRect(QtWidgets.QStyle.CC_ComboBox, combo_option, QtWidgets.QStyle.SC_ComboBoxArrow, combo)
        arrow = combo.grab(arrow_rect).toImage()
        assert count_pixels(arrow, lambda color: color.red() > 200 and color.green() > 200 and color.blue() > 200) >= 4
        spin_option = QtWidgets.QStyleOptionSpinBox()
        spin.initStyleOption(spin_option)
        for subcontrol in (QtWidgets.QStyle.SC_SpinBoxUp, QtWidgets.QStyle.SC_SpinBoxDown):
            arrow_rect = spin.style().subControlRect(QtWidgets.QStyle.CC_SpinBox, spin_option, subcontrol, spin)
            arrow = spin.grab(arrow_rect).toImage()
            assert count_pixels(arrow, lambda color: color.red() > 200 and color.green() > 200 and color.blue() > 200) >= 4
        assert not [message for message in messages if "parse" in message.lower() or "unknown property" in message.lower()]
        surface.close()
    ''')
