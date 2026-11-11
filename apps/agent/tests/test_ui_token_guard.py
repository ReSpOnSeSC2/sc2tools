"""Converted interface files take every colour and font size from theme.py.

Each part of the interface refresh adds the files it converts. A file listed
with function names is checked inside those functions only, until the rest
of it is converted.
"""
from __future__ import annotations

import ast
from pathlib import Path
import re

import pytest

UI = Path(__file__).resolve().parents[1] / "sc2tools_agent" / "ui"
CONVERTED = {
    "activity_log.py": None,
    "brand_mark.py": None,
    "build_checkin_settings.py": None,
    "folder_rows.py": None,
    "game_dashboard.py": None,
    "gui.py": None,
    "health_card.py": None,
    "help_links.py": None,
    "help_page.py": None,
    "pairing_card.py": None,
    "qt_helpers.py": ("scrolling_page", "install_responsive_forms"),
    "recent_games.py": None,
    "service_notice.py": None,
    "system_motion.py": None,
    "update_card.py": None,
    "window_chrome.py": None,
    "race_visuals.py": ("css_for_skin", "_companion_layer"),
}
HEX_COLOUR = re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b")
STYLE_LITERAL = re.compile(r"\b(?:rgba?|hsla?)\s*\(|font-size|\bfont\s*:", re.IGNORECASE)
NAMED_COLOUR = re.compile(r"\b(?:color|background(?:-color)?|border(?:-[a-z]+)*)\s*:[^;{}]*?"
                          r"\b(?:white|black|red|green|blue|cyan|magenta|yellow|gr[ae]y|orange|purple|pink)\b",
                          re.IGNORECASE)
LITERAL_CALLS = {"QColor", "fromRgb", "fromRgbF", "fromHsv", "fromHsl", "fromString",
                 "setPointSize", "setPointSizeF", "setPixelSize"}
# A number in a QFont call is a point size or a weight.
NUMBER_CALLS = {"QFont"}
QT_COLOURS = {"white", "black", "red", "darkRed", "green", "darkGreen", "blue", "darkBlue", "cyan",
              "darkCyan", "magenta", "darkMagenta", "yellow", "darkYellow", "gray", "darkGray", "lightGray"}


def _call_name(call):
    return call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, "id", "")


def _owner_name(node):
    return getattr(node, "attr", getattr(node, "id", ""))


def _violation(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return any(pattern.search(node.value) for pattern in (HEX_COLOUR, STYLE_LITERAL, NAMED_COLOUR))
    if isinstance(node, ast.Call) and _call_name(node) in LITERAL_CALLS:
        return any(isinstance(argument, ast.Constant) for argument in node.args)
    if isinstance(node, ast.Call) and _call_name(node) in NUMBER_CALLS:
        values = (*node.args, *(keyword.value for keyword in node.keywords))
        return any(isinstance(value, ast.Constant) and type(value.value) in (int, float) for value in values)
    if isinstance(node, ast.Attribute) and node.attr in QT_COLOURS:
        return _owner_name(node.value) in ("Qt", "GlobalColor")
    return False


def violations(source, scope=None):
    """``[(line, snippet), ...]`` where ``source`` sets a colour or a font size itself."""
    tree = ast.parse(source)
    roots = [tree] if scope is None else [node for node in ast.walk(tree)
                                          if isinstance(node, ast.FunctionDef) and node.name in scope]
    return [(node.lineno, ast.unparse(node)[:80]) for root in roots for node in ast.walk(root) if _violation(node)]


@pytest.mark.parametrize("filename", sorted(CONVERTED))
def test_converted_files_set_no_colour_or_font_size_of_their_own(filename):
    source = (UI / filename).read_text(encoding="utf-8")
    scope = CONVERTED[filename]
    if scope is not None:
        defined = {node.name for node in ast.walk(ast.parse(source)) if isinstance(node, ast.FunctionDef)}
        assert set(scope) <= defined, set(scope) - defined
    assert violations(source, scope) == []


@pytest.mark.parametrize("snippet", [
    'label.setStyleSheet("color: #55ce89")',
    'label.setStyleSheet("background: rgba(1, 2, 3, 0.5)")',
    'label.setStyleSheet(f"font-size: {12 if small else 13}px")',
    'painter.setPen(QtGui.QColor(255, 0, 0))',
    'painter.setBrush(QtGui.QColor("#fff"))',
    'font.setPointSize(11)',
    'painter.fillRect(rect, QtCore.Qt.white)',
    'painter.setPen(QtCore.Qt.GlobalColor.white)',
    'self.setFont(QtGui.QFont("Segoe UI", 11))',
    'self.setFont(QtGui.QFont(family, pointSize=11))',
    'label.setStyleSheet("QLabel { color: white; }")',
    'button.setStyleSheet(f"border: 1px solid gray; padding: {theme.SPACE_S}px")',
])
def test_the_guard_catches_each_way_of_setting_a_colour_or_size(snippet):
    assert violations(snippet)


@pytest.mark.parametrize("snippet", [
    'label.setStyleSheet("color: " + theme.SUCCESS)',
    'painter.setBrush(QtGui.QColor(theme.SKINS[skin].accent))',
    'pixmap.fill(QtCore.Qt.transparent)',
    'pixmap.fill(QtCore.Qt.GlobalColor.transparent)',
    'font = QtGui.QFont(self.font())',
    'label.setStyleSheet(f"border: 1px solid transparent; color: {theme.TEXT}")',
    'label.setObjectName("muted")',
])
def test_the_guard_allows_theme_tokens(snippet):
    assert violations(snippet) == []


def test_a_listed_function_is_checked_and_the_rest_of_its_file_is_not():
    source = 'def converted():\n    return "#ffffff"\n\ndef later():\n    return "#000000"\n'
    assert [line for line, _snippet in violations(source, ("converted",))] == [2]
