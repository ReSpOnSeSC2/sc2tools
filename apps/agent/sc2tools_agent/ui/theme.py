"""Design tokens and stylesheets for the desktop agent; this module is Qt-free.

Every colour, type size, spacing step, corner radius, elevation level and
motion duration of the interface lives here, and every stylesheet is built
from them. Surfaces and text are shared by all skins. A skin changes only the
window canvas, its one accent and the focus ring (``SKINS``); the race artwork
and the brand mark carry the rest of its identity. The website's design system
(docs/design-system.md) lends its scale and restraint, not its palette.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

from . import palette

# ---- type: the system face, Segoe UI Variable on Windows 11 and Segoe UI before it
FONT_FAMILY = "'Segoe UI Variable Text', 'Segoe UI', sans-serif"
FONT_FAMILY_DISPLAY = "'Segoe UI Variable Display', 'Segoe UI', sans-serif"
FONT_FAMILY_MONO = "'Cascadia Mono', 'Consolas', monospace"
TYPE_CAPTION = 11
TYPE_SMALL = 12
TYPE_BODY = 13
TYPE_SUBTITLE = 15
TYPE_TITLE = 18
TYPE_HEADLINE = 24
TYPE_CODE = 40
WEIGHT_REGULAR = 400
WEIGHT_SEMIBOLD = 600
WEIGHT_BOLD = 700

# ---- spacing on a 4 px grid, and corner radius
SPACE_2XS = 2
SPACE_XS = 4
SPACE_S = 8
SPACE_M = 12
SPACE_L = 16
SPACE_XL = 24
RADIUS_S = 4
RADIUS_M = 6
RADIUS_L = 8
RADIUS_XL = 12
# The inset of a page's content inside the display.
PAGE_MARGIN_X = 28
PAGE_MARGIN_Y = 24
# The least height of a page's list or log; the page scrolls below it.
PAGE_LIST_MIN_HEIGHT = 160
# The round "?" beside a setting or a status line.
HELP_LINK_SIZE = 20
CHECKIN_ROW_HEIGHT = 30
STREAM_TITLE_HEIGHT = 44
STREAM_DESCRIPTION_HEIGHT = 112
STREAM_CANVAS_LANDSCAPE = (54, 32)
STREAM_CANVAS_PORTRAIT = (28, 40)
STREAM_CANVAS_WIDTH = 58

# ---- surfaces: elevation is tone, never a shadow; each level is one step lighter
# The window canvas below them belongs to each skin (``Skin.canvas``; ``BG`` is the default's).
SURFACE = "#15161a"
ELEVATED = "#1c1d22"
SUBTLE = "#25262c"
SUNKEN = "#101114"
BUTTON = "#27282e"
BUTTON_HOVER = "#303139"
BUTTON_PRESSED = "#393a43"
BORDER = "#26272e"
BORDER_STRONG = "#383a43"
# Outlines that alone mark a field or a check box: at least 3:1 on every surface.
BORDER_CONTROL = "#70737f"

# ---- text: TEXT, TEXT_MUTED and TEXT_DIM read at 4.5:1 or more on every surface
TEXT = "#ececf1"
TEXT_MUTED = "#a8aab6"
TEXT_DIM = "#9597a4"
TEXT_DISABLED = "#5f616c"



def tint(color, alpha):
    """``color`` at ``alpha`` (0 to 1) opacity, as a style sheet ``rgba()``."""
    red, green, blue = (int(color[index:index + 2], 16) for index in (1, 3, 5))
    return f"rgba({red}, {green}, {blue}, {alpha})"


# ---- status, shared with the tray icon (palette.py) and identical in every skin
SUCCESS = palette.GREEN
WARNING = palette.AMBER
DANGER = palette.RED
INFO = palette.CYAN
SUCCESS_TINT = tint(SUCCESS, 0.14)
WARNING_TINT = tint(WARNING, 0.14)
DANGER_TINT = tint(DANGER, 0.14)
INFO_TINT = tint(INFO, 0.14)
DANGER_EDGE = tint(DANGER, 0.45)
# Windows' own close-button red, with the white glyph it carries.
DANGER_SOLID = "#c42b1c"
ON_DANGER_SOLID = "#ffffff"
# Companion's second highlight and console frame, until Companion takes the skin tokens.
ACCENT_CYAN = "#71e2d2"

# ---- motion: short, and only when the player and Windows both allow it
MOTION_EXPAND_MS = 300

# How much accent shows through a selected row and a progress bar. A selected
# row keeps every status colour at 4.5:1, so its tint stays light.
SELECTED_TINT = 0.14
PROGRESS_TINT = 0.4


def blend(color, base, amount):
    """``color`` laid over ``base`` at ``amount`` (0 to 1), as a ``#rrggbb`` string."""
    pairs = zip((int(color[index:index + 2], 16) for index in (1, 3, 5)),
                (int(base[index:index + 2], 16) for index in (1, 3, 5)))
    return "#" + "".join(f"{round(top * amount + bottom * (1 - amount)):02x}" for top, bottom in pairs)


@dataclass(frozen=True)
class Skin:
    """One skin's colours: the window canvas, its accent family and the focus ring."""

    canvas: str
    accent: str
    accent_hover: str
    accent_pressed: str
    on_accent: str
    focus: str

    @property
    def selected(self):
        return blend(self.accent, SURFACE, SELECTED_TINT)

    @property
    def progress(self):
        return blend(self.accent, SURFACE, PROGRESS_TINT)


SKINS = {
    "default": Skin("#100f15", "#a78bfa", "#b8a1fb", "#9677f2", "#170c2e", "#d4c8fd"),
    "protoss": Skin("#11100d", "#dfbd6a", "#e8cc8a", "#cfa955", "#1f1606", "#f2e2b3"),
    "terran": Skin("#0d1014", "#7eb0e3", "#9bc3eb", "#689dd4", "#08182a", "#c3dcf6"),
    "zerg": Skin("#120e10", "#ec8b5e", "#f1a27d", "#dd774a", "#2a1004", "#f8c9b0"),
}
DEFAULT_SKIN = SKINS["default"]
BG = DEFAULT_SKIN.canvas
ELEVATION = (BG, SURFACE, ELEVATED, SUBTLE)
ACCENT = DEFAULT_SKIN.accent
ACCENT_HOVER = DEFAULT_SKIN.accent_hover
ACCENT_PRESSED = DEFAULT_SKIN.accent_pressed
ON_ACCENT = DEFAULT_SKIN.on_accent
BUTTON_CHECKED = DEFAULT_SKIN.selected
FOCUS = DEFAULT_SKIN.focus

CONTROL_ICONS = {
    name: (Path(__file__).resolve().parent / "assets" / "controls" / f"{name}.svg").as_posix()
    for name in ("check", "dash", "radio-dot", "chevron-down", "chevron-up")
}


def window_controls_style(skin):
    """Minimize, maximize and close: quiet glyphs that fill on hover."""
    return f"""
QToolButton#windowMinimize, QToolButton#windowMaximize, QToolButton#windowClose {{
    background: transparent; color: {TEXT_MUTED}; border: 1px solid transparent;
    border-radius: {RADIUS_M}px; padding: 0; margin: 0; min-width: 0; min-height: 0;
    font-family: 'Segoe UI', sans-serif; font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_REGULAR};
}}
QToolButton#windowMinimize:hover, QToolButton#windowMaximize:hover {{ background: {BUTTON_HOVER}; color: {TEXT}; }}
QToolButton#windowClose:hover {{ background: {DANGER_SOLID}; color: {ON_DANGER_SOLID}; }}
QToolButton#windowMinimize:focus, QToolButton#windowMaximize:focus, QToolButton#windowClose:focus {{
    border-color: {skin.focus};
}}
"""


def _base(skin):
    return f"""
QWidget {{
    background: transparent;
    color: {TEXT};
    font-family: {FONT_FAMILY};
    font-size: {TYPE_BODY}px;
}}
QLabel, QCheckBox, QRadioButton {{ background: transparent; }}
QWidget:disabled {{ color: {TEXT_DISABLED}; }}
QMainWindow, QWidget#agentRoot {{ background: {skin.canvas}; }}
QMainWindow[textOverlay="true"], QWidget#agentRoot[textOverlay="true"],
QFrame#agentFrame[textOverlay="true"], QFrame#agentDisplay[textOverlay="true"],
QStackedWidget#agentPageStack[textOverlay="true"] {{ background: transparent; border: none; }}
QDialog, QMessageBox, QFileDialog, QInputDialog {{ background: {ELEVATED}; color: {TEXT}; }}
QMessageBox QLabel#qt_msgbox_label {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QMessageBox QLabel#qt_msgbox_informativelabel {{ color: {TEXT_MUTED}; }}
QWidget#checkinWindow {{ background: transparent; }}
QDialogButtonBox {{ background: transparent; }}
QStackedWidget, QStackedWidget > QWidget {{ background: {SURFACE}; }}
QScrollArea {{ background: {SURFACE}; border: none; }}
QScrollArea > QWidget > QWidget {{ background: {SURFACE}; }}
"""


def _shell(skin):
    """The window frame, its navigation rail and the page display."""
    return f"""
QFrame#agentFrame {{
    background: {skin.canvas}; border: 1px solid {BORDER}; border-radius: {RADIUS_XL}px;
}}
QFrame#agentFrame[companion="true"], QFrame#agentDisplay[companion="true"] {{
    background: transparent;
    border: none;
    border-radius: 0;
}}
QWidget#agentBrandbar, QWidget#agentPageToolbar {{ background: transparent; border: none; }}
QLabel#agentBrand {{
    font-family: {FONT_FAMILY_DISPLAY}; font-size: {TYPE_SUBTITLE}px;
    font-weight: {WEIGHT_BOLD}; letter-spacing: 1px;
}}
QLabel#agentEdition {{
    color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD}; letter-spacing: 1px;
}}
QLabel#agentBreadcrumb {{ color: {TEXT_MUTED}; font-size: {TYPE_SMALL}px; }}
QFrame#agentSidebar {{ background: transparent; border: none; }}
QFrame#agentDisplay {{
    background: {SURFACE}; border: 1px solid {BORDER}; border-radius: {RADIUS_L}px;
}}
QWidget[agentPage="true"], QScrollArea[agentPage="true"] > QWidget > QWidget {{ background: transparent; }}
QWidget#agentPageToolbar QPushButton, QToolButton#agentMenuButton {{
    background: transparent; color: {TEXT_MUTED}; border-color: transparent;
}}
QWidget#agentPageToolbar QPushButton:hover, QToolButton#agentMenuButton:hover {{
    background: {BUTTON_HOVER}; color: {TEXT};
}}
QWidget#agentPageToolbar QPushButton:focus, QToolButton#agentMenuButton:focus {{ border-color: {skin.focus}; }}
QToolButton#agentMenuButton {{ padding-right: {SPACE_XL}px; }}
QFrame#agentSidebar QPushButton:flat {{ text-align: left; }}
QToolButton#agentMenuButton::menu-indicator {{
    image: url("{CONTROL_ICONS['chevron-down']}"); subcontrol-origin: padding;
    subcontrol-position: center right; right: {SPACE_S}px; width: {SPACE_M}px; height: {SPACE_M}px;
}}
"""


def _content(skin):
    """Cards, headings and the labels pages share."""
    return f"""
QFrame#card, QFrame#studioCard, QFrame#studioDestination {{
    background: {ELEVATED}; border: 1px solid {BORDER}; border-radius: {RADIUS_L}px;
}}
QFrame#cardElevated, QFrame#studioCommand {{
    background: {SUBTLE}; border: 1px solid {BORDER}; border-radius: {RADIUS_L}px;
}}
QFrame#cardArchive {{
    background: {skin.selected}; border: 1px solid {BORDER}; border-color: {skin.accent}; border-radius: {RADIUS_L}px;
}}
QLabel#h1 {{ font-family: {FONT_FAMILY_DISPLAY}; font-size: {TYPE_HEADLINE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#h2 {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#muted {{ color: {TEXT_MUTED}; }}
QLabel#dim {{ color: {TEXT_DIM}; }}
QLabel#hint {{ color: {TEXT_DIM}; font-size: {TYPE_SMALL}px; }}
QLabel#folderSummary[missing="true"] {{ color: {WARNING}; }}
QLabel#stat {{ font-family: {FONT_FAMILY_DISPLAY}; font-size: {TYPE_HEADLINE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QPushButton#statAction {{ text-align: left; }}
QLabel#settingsToastOk {{ color: {SUCCESS}; }}
QLabel#settingsToastErr, QLabel#fieldError, QLabel#error {{ color: {DANGER}; }}
QLabel#code {{
    font-family: {FONT_FAMILY_MONO}; font-size: {TYPE_CODE}px; font-weight: {WEIGHT_BOLD}; letter-spacing: 8px;
    color: {skin.accent}; background: {SUNKEN};
    border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_L}px; padding: 14px {SPACE_XL}px;
}}
QLabel#badgeInfo, QLabel#badgeOk, QLabel#badgeWarn, QLabel#badgeErr, QLabel#badgeNeutral {{
    border-radius: {RADIUS_L}px; padding: {SPACE_XS}px 10px; font-weight: {WEIGHT_SEMIBOLD};
}}
QLabel#badgeInfo {{ color: {INFO}; background: {INFO_TINT}; }}
QLabel#badgeOk {{ color: {SUCCESS}; background: {SUCCESS_TINT}; }}
QLabel#badgeWarn {{ color: {WARNING}; background: {WARNING_TINT}; }}
QLabel#badgeErr {{ color: {DANGER}; background: {DANGER_TINT}; }}
QLabel#badgeNeutral {{ color: {skin.accent}; background: {skin.selected}; }}
"""


def _buttons(skin):
    """Secondary by default, one accent-filled primary, quiet flat and navigation buttons."""
    return f"""
QPushButton, QToolButton {{
    background: {BUTTON}; color: {TEXT};
    border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_M}px;
    padding: 7px 10px; font-weight: {WEIGHT_SEMIBOLD};
}}
QPushButton {{ min-height: 20px; text-align: center; }}
QPushButton:hover, QToolButton:hover {{ background: {BUTTON_HOVER}; }}
QPushButton:pressed, QToolButton:pressed {{ background: {BUTTON_PRESSED}; color: {TEXT_MUTED}; }}
QPushButton:checked, QToolButton:checked {{ background: {skin.selected}; border-color: {skin.accent}; color: {TEXT}; }}
QPushButton:focus, QToolButton:focus {{ border-color: {skin.focus}; }}
QPushButton:flat {{ background: transparent; border-color: transparent; color: {TEXT_MUTED}; }}
QPushButton:flat:hover {{ background: {BUTTON_HOVER}; color: {TEXT}; }}
QPushButton:flat:focus {{ border-color: {skin.focus}; }}
QPushButton#danger, QPushButton#dangerButton {{ color: {DANGER}; border-color: {DANGER_EDGE}; }}
QPushButton#danger:hover, QPushButton#dangerButton:hover {{ background: {DANGER_TINT}; border-color: {DANGER}; }}
QPushButton#primary {{ background: {skin.accent}; border-color: {skin.accent}; color: {skin.on_accent}; }}
QPushButton#primary:hover {{ background: {skin.accent_hover}; border-color: {skin.accent_hover}; }}
QPushButton#primary:pressed {{ background: {skin.accent_pressed}; border-color: {skin.accent_pressed}; }}
QPushButton#primary:focus, QPushButton#danger:focus, QPushButton#dangerButton:focus {{ border-color: {skin.focus}; }}
QPushButton#navItem {{
    background: transparent; color: {TEXT_MUTED}; font-weight: {WEIGHT_REGULAR};
    border: 1px solid transparent; border-left: 3px solid transparent;
    border-radius: {RADIUS_M}px; padding: 9px 14px 9px 12px; text-align: left;
}}
QPushButton#navItem:hover {{ background: {BUTTON_HOVER}; color: {TEXT}; }}
QPushButton#navItem:checked {{
    background: {skin.selected}; color: {TEXT}; font-weight: {WEIGHT_SEMIBOLD}; border-left-color: {skin.accent};
}}
QPushButton#navItem:focus, QPushButton#navItem:checked:focus {{ border-color: {skin.focus}; }}
QPushButton#segment {{ padding: 6px {SPACE_L}px; }}
QPushButton#quietButton {{
    background: transparent; color: {TEXT_MUTED}; border-color: transparent; padding: 6px 10px;
}}
QPushButton#quietButton:hover {{ background: {BUTTON_HOVER}; color: {TEXT}; }}
QPushButton#quietButton:focus {{ border-color: {skin.focus}; }}
QToolButton#helpLink {{
    background: transparent; border: 1px solid {BORDER_CONTROL}; border-radius: {HELP_LINK_SIZE // 2}px;
    color: {TEXT_MUTED}; padding: 0; font-size: {TYPE_SMALL}px;
}}
QToolButton#helpLink:hover {{ background: {BUTTON_HOVER}; color: {TEXT}; }}
QToolButton#helpLink:focus {{ border-color: {skin.focus}; }}
QPushButton:disabled, QToolButton:disabled,
QPushButton#primary:disabled, QPushButton#danger:disabled, QPushButton#dangerButton:disabled,
QPushButton#navItem:disabled, QPushButton#quietButton:disabled {{
    background: {SURFACE}; color: {TEXT_DISABLED}; border-color: {BORDER};
}}
QPushButton:flat:disabled {{ background: transparent; border-color: transparent; }}
"""


def _inputs(skin):
    """Text fields, combo boxes and spin boxes."""
    return f"""
QLineEdit, QComboBox, QPlainTextEdit, QTextEdit, QTextBrowser, QAbstractSpinBox {{
    background: {SUNKEN}; color: {TEXT}; border: 1px solid {BORDER_CONTROL};
    border-radius: {RADIUS_M}px; padding: 7px 10px;
    selection-background-color: {skin.accent}; selection-color: {skin.on_accent};
}}
QLineEdit:hover, QComboBox:hover, QPlainTextEdit:hover, QTextEdit:hover, QAbstractSpinBox:hover {{
    border-color: {TEXT_DIM};
}}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus, QTextEdit:focus,
QTextBrowser:focus, QAbstractSpinBox:focus {{ border-color: {skin.focus}; }}
QLineEdit:disabled, QComboBox:disabled, QPlainTextEdit:disabled, QTextEdit:disabled,
QTextBrowser:disabled, QAbstractSpinBox:disabled {{
    background: {SURFACE}; color: {TEXT_DISABLED}; border-color: {BORDER_STRONG};
}}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox {{ padding-right: 28px; }}
QComboBox::down-arrow {{ image: url("{CONTROL_ICONS['chevron-down']}"); width: {SPACE_L}px; height: {SPACE_L}px; }}
QComboBox QAbstractItemView {{
    background: {SUBTLE}; color: {TEXT}; border: 1px solid {BORDER_STRONG}; outline: none;
    selection-background-color: {skin.selected}; selection-color: {TEXT};
}}
QAbstractSpinBox::up-button, QAbstractSpinBox::down-button {{ background: transparent; border: none; width: 18px; }}
QAbstractSpinBox {{ padding-right: 26px; }}
QAbstractSpinBox::up-button {{ subcontrol-origin: border; subcontrol-position: top right; }}
QAbstractSpinBox::down-button {{ subcontrol-origin: border; subcontrol-position: bottom right; }}
QAbstractSpinBox::up-button:hover, QAbstractSpinBox::down-button:hover {{ background: {BUTTON_HOVER}; }}
QAbstractSpinBox::up-arrow {{ image: url("{CONTROL_ICONS['chevron-up']}"); width: {SPACE_M}px; height: {SPACE_M}px; }}
QAbstractSpinBox::down-arrow {{ image: url("{CONTROL_ICONS['chevron-down']}"); width: {SPACE_M}px; height: {SPACE_M}px; }}
"""


def _choices(skin):
    """Check boxes, radio buttons, sliders and progress bars."""
    return f"""
QCheckBox, QRadioButton {{ color: {TEXT}; spacing: {SPACE_S}px; }}
QCheckBox::indicator, QRadioButton::indicator {{
    width: {SPACE_L}px; height: {SPACE_L}px; border: 1px solid {BORDER_CONTROL}; background: {SUNKEN};
}}
QCheckBox::indicator {{ border-radius: {RADIUS_S}px; }}
QRadioButton::indicator {{ border-radius: {SPACE_S}px; }}
QCheckBox::indicator:hover, QRadioButton::indicator:hover {{ border-color: {TEXT_MUTED}; }}
QCheckBox::indicator:checked, QRadioButton::indicator:checked {{ background: {skin.accent}; border-color: {skin.accent}; }}
QCheckBox::indicator:checked {{ image: url("{CONTROL_ICONS['check']}"); }}
QRadioButton::indicator:checked {{ image: url("{CONTROL_ICONS['radio-dot']}"); }}
QCheckBox::indicator:indeterminate {{
    background: {skin.selected}; border-color: {skin.accent}; image: url("{CONTROL_ICONS['dash']}");
}}
QCheckBox::indicator:focus, QRadioButton::indicator:focus {{ border-color: {skin.focus}; }}
QCheckBox:disabled, QRadioButton:disabled {{ color: {TEXT_DISABLED}; }}
QCheckBox::indicator:disabled, QRadioButton::indicator:disabled {{ background: {SURFACE}; border-color: {BORDER_STRONG}; }}
QCheckBox::indicator:checked:disabled, QRadioButton::indicator:checked:disabled {{ background: {BORDER_STRONG}; }}
QProgressBar {{
    background: {SUNKEN}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS_S}px; text-align: center; min-height: {SPACE_M}px;
}}
QProgressBar::chunk {{ background: {skin.progress}; border-radius: 3px; }}
QProgressBar:disabled {{ color: {TEXT_DISABLED}; border-color: {BORDER}; }}
QProgressBar::chunk:disabled {{ background: {BORDER_STRONG}; }}
QSlider::groove:horizontal {{ background: {SUNKEN}; border: 1px solid {BORDER_STRONG}; height: 6px; border-radius: 3px; }}
QSlider::sub-page:horizontal {{ background: {skin.accent}; border-radius: 3px; }}
QSlider::handle:horizontal {{
    background: {TEXT}; border: 1px solid {BORDER}; border-color: {skin.accent};
    width: {SPACE_L}px; margin: -6px 0; border-radius: {SPACE_S}px;
}}
QSlider::groove:vertical {{ background: {SUNKEN}; border: 1px solid {BORDER_STRONG}; width: 6px; border-radius: 3px; }}
QSlider::add-page:vertical {{ background: {skin.accent}; border-radius: 3px; }}
QSlider::handle:vertical {{
    background: {TEXT}; border: 1px solid {BORDER}; border-color: {skin.accent};
    height: {SPACE_L}px; margin: 0 -6px; border-radius: {SPACE_S}px;
}}
QSlider::handle:hover, QSlider::handle:focus {{ border-color: {skin.focus}; }}
QSlider::handle:disabled {{ background: {TEXT_DISABLED}; border-color: {BORDER}; }}
QSlider::sub-page:horizontal:disabled, QSlider::add-page:vertical:disabled {{ background: {BORDER_STRONG}; }}
"""


def _views(skin):
    """Tables, lists, trees, their headers, tabs and group boxes."""
    return f"""
QTableView, QTableWidget, QTreeView, QTreeWidget, QListView, QListWidget {{
    background: {SURFACE}; alternate-background-color: {ELEVATED}; color: {TEXT};
    border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_L}px;
    gridline-color: {BORDER}; selection-background-color: {skin.selected};
    selection-color: {TEXT}; outline: none;
}}
QTableView::item, QTableWidget::item, QTreeView::item, QTreeWidget::item, QListView::item, QListWidget::item {{
    padding: 6px {SPACE_S}px; border-bottom: 1px solid {BORDER};
}}
QTableView::item:hover, QTableWidget::item:hover, QTreeView::item:hover,
QTreeWidget::item:hover, QListView::item:hover, QListWidget::item:hover {{ background: {BUTTON_HOVER}; }}
QTableView::item:selected, QTableWidget::item:selected, QTreeView::item:selected,
QTreeWidget::item:selected, QListView::item:selected, QListWidget::item:selected {{ background: {skin.selected}; color: {TEXT}; }}
QTableView:focus, QTableWidget:focus, QTreeView:focus, QTreeWidget:focus,
QListView:focus, QListWidget:focus {{ border-color: {skin.focus}; }}
QTableView:disabled, QTableWidget:disabled, QTreeView:disabled, QTreeWidget:disabled,
QListView:disabled, QListWidget:disabled {{ color: {TEXT_DISABLED}; border-color: {BORDER}; }}
QHeaderView::section {{
    background: {ELEVATED}; color: {TEXT_MUTED}; border: none; border-bottom: 1px solid {BORDER_STRONG};
    padding: {SPACE_S}px; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD};
}}
QTableCornerButton::section {{ background: {ELEVATED}; border: none; }}
QTabWidget::pane {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: {RADIUS_M}px; }}
QTabBar::tab {{
    background: transparent; color: {TEXT_MUTED}; border: none; border-bottom: 2px solid transparent;
    padding: {SPACE_S}px 14px; margin-right: {SPACE_XS}px;
}}
QTabBar::tab:hover {{ color: {TEXT}; border-bottom-color: {BORDER_CONTROL}; }}
QTabBar::tab:selected {{ color: {TEXT}; border-bottom-color: {skin.accent}; }}
QTabBar::tab:focus {{ color: {TEXT}; border-bottom-color: {skin.focus}; }}
QTabBar::tab:disabled {{ color: {TEXT_DISABLED}; }}
QGroupBox {{
    background: {ELEVATED}; border: 1px solid {BORDER}; border-radius: {RADIUS_L}px;
    margin-top: 14px; padding-top: 14px;
}}
QGroupBox::title {{
    subcontrol-origin: margin; left: {SPACE_M}px; padding: 0 5px; color: {TEXT_MUTED}; font-weight: {WEIGHT_SEMIBOLD};
}}
"""


def _overlays(skin):
    """Scroll bars, splitters, menus and tooltips."""
    return f"""
QScrollBar:vertical {{ background: transparent; width: 10px; margin: {SPACE_XS}px 2px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px {SPACE_XS}px; }}
QScrollBar::handle:vertical {{ background: {BORDER_STRONG}; border-radius: 3px; min-height: {SPACE_XL}px; }}
QScrollBar::handle:horizontal {{ background: {BORDER_STRONG}; border-radius: 3px; min-width: {SPACE_XL}px; }}
QScrollBar::handle:vertical:hover, QScrollBar::handle:horizontal:hover {{ background: {TEXT_DIM}; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical,
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{ background: transparent; }}
QSplitter::handle {{ background: {BORDER}; }}
QSplitter::handle:hover {{ background: {BORDER_STRONG}; }}
QMenuBar {{ background: {SURFACE}; color: {TEXT}; }}
QMenuBar::item {{ background: transparent; padding: 6px 10px; }}
QMenuBar::item:selected {{ background: {BUTTON_HOVER}; }}
QMenu {{ background: {ELEVATED}; color: {TEXT}; border: 1px solid {BORDER_STRONG}; padding: {SPACE_XS}px; }}
QMenu::item {{ padding: {SPACE_S}px {SPACE_XL}px {SPACE_S}px {SPACE_M}px; border-radius: {RADIUS_M}px; }}
QMenu::item:selected {{ background: {skin.selected}; color: {TEXT}; }}
QMenu::item:disabled {{ color: {TEXT_DISABLED}; }}
QMenu::separator {{ height: 1px; background: {BORDER_STRONG}; margin: {SPACE_XS}px {SPACE_S}px; }}
QToolTip {{
    background: {SUBTLE}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS_S}px; padding: 6px {SPACE_S}px;
}}
"""


def _studio(skin):
    """The activity log and the Streams page."""
    return f"""
QPlainTextEdit#log {{
    font-family: {FONT_FAMILY_MONO}; font-size: {TYPE_SMALL}px; background: {SUNKEN}; color: {TEXT_MUTED};
    border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_L}px;
}}
QPlainTextEdit#log:focus {{ border-color: {skin.focus}; }}
QWidget#studioContent, QScrollArea#streamStudio {{ background: {skin.canvas}; }}
QWidget#studioTransparent {{ background: transparent; }}
QLineEdit#streamTitle {{
    font-size: {TYPE_TITLE}px; font-weight: {WEIGHT_SEMIBOLD}; background: {SUNKEN}; padding: {SPACE_S}px {SPACE_M}px;
}}
QLineEdit#streamTitle:focus {{ border-color: {skin.focus}; }}
QLabel#studioEyebrow {{ color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD}; letter-spacing: 1px; }}
QLabel#studioCounter, QLabel#studioNotice {{ color: {TEXT_MUTED}; font-size: {TYPE_SMALL}px; }}
QLabel#studioDestinationTitle {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; color: {TEXT}; }}
QLabel#canvasLandscape, QLabel#canvasPortrait {{
    background: {ELEVATED}; color: {TEXT_MUTED}; border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS_S}px; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD};
}}
QLabel#studioBadge {{
    background: {SUBTLE}; color: {TEXT_MUTED}; border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS_L}px; padding: {SPACE_XS}px {SPACE_S}px; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD};
}}
QLabel#studioBadge[tone="good"] {{ background: {SUCCESS_TINT}; border-color: {SUCCESS_TINT}; color: {SUCCESS}; }}
QLabel#studioBadge[tone="live"] {{ background: {DANGER_TINT}; border-color: {DANGER_TINT}; color: {DANGER}; }}
QLabel#studioBadge[tone="warning"] {{ background: {WARNING_TINT}; border-color: {WARNING_TINT}; color: {WARNING}; }}
QToolButton#studioDisclosureToggle {{
    background: {ELEVATED}; color: {TEXT_MUTED}; border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS_L}px; text-align: left; padding: {SPACE_M}px; font-weight: {WEIGHT_SEMIBOLD};
}}
QToolButton#studioDisclosureToggle:hover, QToolButton#studioDisclosureToggle:checked {{
    background: {BUTTON_HOVER}; color: {TEXT}; border-color: {skin.accent};
}}
QToolButton#studioDisclosureToggle:focus {{ border-color: {skin.focus}; }}
QToolButton#studioDisclosureToggle:disabled {{ background: {SURFACE}; color: {TEXT_DISABLED}; border-color: {BORDER}; }}
"""


def _companion_page(skin):
    return f"""
QWidget#companionDesk, QWidget#companionContent, QWidget#companionPanel {{
    background: {skin.canvas}; color: {TEXT};
}}
QWidget#companionDesk[textOverlay="true"], QWidget#companionPanel[textOverlay="true"] {{
    background: transparent; border: none;
}}
QFrame#companionCard {{ background: {ELEVATED}; border: none; border-radius: {RADIUS_L}px; }}
QLabel#companionHeading {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#companionHeading[scoutingCompact="true"] {{ font-size: {TYPE_SMALL}px; }}
QLabel#companionMuted {{ color: {TEXT_MUTED}; font-size: {TYPE_SMALL}px; }}
QLabel#companionAccent {{ color: {skin.accent}; font-size: {TYPE_SMALL}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QWidget#companionDesk QLineEdit, QWidget#companionDesk QPlainTextEdit,
QWidget#companionDesk QComboBox, QWidget#companionPanel QComboBox {{
    background: {SUNKEN}; border: 1px solid {BORDER_CONTROL}; border-radius: {RADIUS_M}px;
}}
QWidget#companionDesk QLineEdit:focus, QWidget#companionDesk QPlainTextEdit:focus,
QWidget#companionDesk QComboBox:focus, QWidget#companionPanel QComboBox:focus {{ border-color: {skin.focus}; }}
QWidget#companionDesk QTreeWidget, QWidget#companionDesk QListWidget, QWidget#companionPanel QTreeWidget {{
    background: {SURFACE}; alternate-background-color: {ELEVATED}; color: {TEXT};
    border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_M}px; outline: none;
}}
QWidget#companionDesk QTreeWidget:focus, QWidget#companionDesk QListWidget:focus,
QWidget#companionPanel QTreeWidget:focus {{ border-color: {skin.focus}; }}
QWidget#companionDesk QTreeWidget::item, QWidget#companionPanel QTreeWidget::item {{
    padding: {SPACE_XS}px {SPACE_S}px;
}}
QWidget#companionDesk QCheckBox:disabled, QWidget#companionPanel QCheckBox:disabled {{ color: {TEXT_DIM}; }}
QWidget#companionDesk QListWidget::item {{ padding: {SPACE_M}px {SPACE_S}px; border-bottom: 1px solid {BORDER}; }}
QWidget#companionDesk QListWidget::item:selected {{ background: {skin.selected}; color: {TEXT}; }}
"""


def _companion_console(skin):
    return f"""
QFrame#companionConsole {{
    background: {skin.canvas}; border: 1px solid {BORDER}; border-radius: {RADIUS_XL}px; color: {TEXT};
}}
QFrame#consoleProfile {{ background: {ELEVATED}; border: none; border-radius: {RADIUS_L}px; }}
QFrame#consoleDisplay {{ background: {SURFACE}; border: none; border-radius: {RADIUS_L}px; }}
QWidget#consoleHome, QScrollArea#consoleHomeScroll, QStackedWidget#consolePages, QScrollArea#consoleProfileScroll,
QScrollArea#consoleHomeScroll > QWidget > QWidget,
QScrollArea#consoleProfileScroll > QWidget > QWidget {{ background: transparent; border: none; }}
QLabel#consoleBrand {{
    font-family: {FONT_FAMILY_DISPLAY}; font-size: {TYPE_TITLE}px; font-weight: {WEIGHT_SEMIBOLD};
}}
QLabel#consoleEdition {{
    color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD}; letter-spacing: 1px;
}}
QLabel#consoleBreadcrumb, QLabel#consoleOpponentRecord {{ color: {TEXT_MUTED}; font-size: {TYPE_SMALL}px; }}
QLabel#consoleGameTitle {{ color: {skin.accent}; font-size: {TYPE_SMALL}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#consolePageHeading {{
    font-family: {FONT_FAMILY_DISPLAY}; font-size: {TYPE_HEADLINE}px; font-weight: {WEIGHT_SEMIBOLD};
}}
QLabel#consolePageDescription {{ color: {TEXT_MUTED}; font-size: {TYPE_BODY}px; }}
QLabel#consoleOpponentIdentity {{ color: {TEXT}; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QPushButton#consoleHomeAction {{
    text-align: left; padding: {SPACE_S}px {SPACE_M}px; background: {ELEVATED}; border-color: transparent;
}}
QPushButton#consoleHomeAction:hover {{ background: {BUTTON_HOVER}; }}
QPushButton#consoleHomeAction:focus {{ border-color: {skin.focus}; }}
QFrame#companionConsole QPushButton:disabled, QFrame#companionConsole QToolButton:disabled {{ color: {TEXT_DIM}; }}
QFrame#consoleDivider {{ background: {BORDER}; border: none; max-height: 1px; }}
"""


def _companion_ghost(skin):
    return f"""
QWidget#ghostDesk, QWidget#ghostPanel, QWidget#ghostContent, QWidget#ghostSource {{
    background: {SURFACE}; color: {TEXT}; font-size: {TYPE_BODY}px;
}}
QLabel#ghostHeading {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QWidget#ghostDesk QLineEdit, QWidget#ghostDesk QComboBox {{ background: {SUNKEN}; border-color: {BORDER_CONTROL}; }}
QWidget#ghostDesk QLineEdit:focus, QWidget#ghostDesk QComboBox:focus {{ border-color: {skin.focus}; }}
QWidget#ghostDesk QCheckBox:disabled {{ color: {TEXT_DIM}; }}
QWidget#ghostDesk QTreeWidget, QWidget#ghostPanel QTreeWidget {{
    background: {ELEVATED}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    border-radius: {RADIUS_M}px; selection-background-color: {skin.selected}; selection-color: {TEXT};
}}
QWidget#ghostDesk QTreeWidget:focus, QWidget#ghostPanel QTreeWidget:focus {{ border-color: {skin.focus}; }}
QToolButton#ghostHistory {{
    background: transparent; color: {TEXT_MUTED}; border: 1px solid transparent;
    border-radius: {RADIUS_S}px; padding: {SPACE_XS}px {SPACE_S}px;
}}
QToolButton#ghostHistory:hover {{ background: {BUTTON_HOVER}; color: {TEXT}; }}
QToolButton#ghostHistory:focus {{ border-color: {skin.focus}; }}
"""


def _companion_builds(skin):
    return f"""
QLabel#companionBuildsHeading {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; color: {TEXT}; }}
QWidget#companionBuilds QTabWidget::pane {{ background: {SURFACE}; border: none; }}
QWidget#companionBuilds QTabBar::tab {{
    background: transparent; color: {TEXT_MUTED}; border: none; border-bottom: 2px solid transparent;
    padding: {SPACE_S}px {SPACE_M}px;
}}
QWidget#companionBuilds QTabBar::tab:hover {{ color: {TEXT}; }}
QWidget#companionBuilds QTabBar::tab:selected {{ color: {TEXT}; border-bottom-color: {skin.accent}; }}
QWidget#companionBuilds QTabBar::tab:focus {{ border-bottom-color: {skin.focus}; }}
"""


def companion_builds_stylesheet(skin=DEFAULT_SKIN):
    return card_stylesheet(skin) + _companion_builds(skin)


def card_stylesheet(skin=DEFAULT_SKIN):
    """Compact, self-contained theme for parentless build check-in cards."""
    return f"""
QWidget {{ background-color: transparent; color: {TEXT}; font-family: {FONT_FAMILY}; font-size: {TYPE_SMALL}px; }}
QFrame#card {{ background: {SURFACE}; border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_XL}px; }}
QLabel {{ background: transparent; border: none; }}
QLabel#checkinPreview {{
    color: {skin.accent}; background: {skin.selected}; border-radius: {RADIUS_M}px; padding: 2px {SPACE_S}px;
}}
QLabel#checkinEyebrow, QLabel#checkinSection {{
    color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_SEMIBOLD}; letter-spacing: 1px;
}}
QLabel#checkinTitle, QLabel#checkinResult {{ font-size: {TYPE_SUBTITLE}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#checkinResult, QLabel#checkinMuted, QLabel#checkinCounter, QLabel#checkinStatus {{ color: {TEXT_MUTED}; }}
QLabel#checkinResult[tone="success"] {{ color: {SUCCESS}; }}
QLabel#checkinResult[tone="danger"], QLabel#checkinCounter[tone="danger"] {{ color: {DANGER}; }}
QLabel#checkinCounter[tone="warning"], QLabel#checkinStatus[tone="warning"] {{ color: {WARNING}; }}
QLabel#checkinGrip {{ color: {TEXT_DIM}; font-size: {TYPE_SUBTITLE}px; }}
QLabel#checkinCounter, QLabel#checkinIntro, QLabel#checkinChanged {{ font-size: {TYPE_CAPTION}px; }}
QLabel#checkinChanged {{ color: {skin.accent}; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#checkinLocked {{ font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#checkinLocked[saving="true"] {{ color: {TEXT_MUTED}; }}
QLabel#checkinPrompt {{ font-size: {TYPE_BODY}px; }}
QFrame#checkinStrip, QFrame#checkinIntroBox {{ background: {ELEVATED}; border: none; border-radius: {RADIUS_L}px; }}
QPushButton {{
    background: {BUTTON}; color: {TEXT}; border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_M}px;
    padding: {SPACE_XS}px {SPACE_M}px; min-height: 18px; font-weight: {WEIGHT_SEMIBOLD};
}}
QPushButton:hover {{ background: {BUTTON_HOVER}; }}
QPushButton:pressed {{ background: {BUTTON_PRESSED}; }}
QPushButton#checkinPrimary {{ background: {skin.accent}; color: {skin.on_accent}; border-color: {skin.accent}; }}
QPushButton#checkinPrimary:hover {{ background: {skin.accent_hover}; border-color: {skin.accent_hover}; }}
QPushButton#checkinPrimary:pressed {{ background: {skin.accent_pressed}; border-color: {skin.accent_pressed}; }}
QPushButton:disabled, QPushButton#checkinPrimary:disabled {{ background: {ELEVATED}; color: {TEXT_DIM}; border-color: {BORDER}; }}
QPushButton#checkinQuiet {{ background: transparent; border-color: transparent; color: {TEXT_MUTED}; }}
QPushButton#checkinQuiet:hover {{ background: {SUBTLE}; color: {TEXT}; }}
QPushButton#checkinSmall {{ padding: 2px {SPACE_S}px; min-height: {SPACE_L}px; font-size: {TYPE_CAPTION}px; }}
QPushButton#checkinLink, QPushButton#checkinMoreToggle {{
    background: transparent; border: 1px solid transparent; padding: 0; min-height: 0;
    color: {skin.accent}; font-size: {TYPE_CAPTION}px; text-align: left;
}}
QPushButton#checkinMoreToggle {{ color: {TEXT_MUTED}; }}
QPushButton#checkinLink:hover, QPushButton#checkinMoreToggle:hover {{ color: {TEXT}; text-decoration: underline; }}
QPushButton#checkinLink:disabled, QPushButton#checkinQuiet:disabled {{ background: transparent; border-color: transparent; color: {TEXT_DIM}; }}
QPushButton:focus, QPushButton#checkinPrimary:focus, QPushButton#checkinQuiet:focus,
QPushButton#checkinLink:focus, QPushButton#checkinMoreToggle:focus {{ border-color: {skin.focus}; }}
QLineEdit#checkinSearch, QPlainTextEdit#checkinNotes {{
    background: {SUNKEN}; color: {TEXT}; border: 1px solid {BORDER_CONTROL}; border-radius: {RADIUS_M}px;
    padding: {SPACE_XS}px {SPACE_S}px; selection-background-color: {skin.accent}; selection-color: {skin.on_accent};
}}
QLineEdit#checkinSearch:focus, QPlainTextEdit#checkinNotes:focus {{ border-color: {skin.focus}; }}
QScrollArea, QScrollArea > QWidget > QWidget {{ background: transparent; border: none; }}
QProgressBar#checkinBusy {{ background: {BORDER}; border: none; border-radius: 1px; max-height: 2px; min-height: 2px; }}
QProgressBar#checkinBusy::chunk {{ background: {skin.accent}; border-radius: 1px; }}
""" + _overlays(skin)


def checkin_chip_colours(skin, tone):
    if tone == "rolled":
        return blend(WARNING, SURFACE, SELECTED_TINT), WARNING
    if tone == "usual":
        return SUBTLE, skin.accent
    return skin.selected, skin.accent


def _recent_builds(skin):
    return f"""
QPushButton#recentBuildRow {{ background: {ELEVATED}; border: 1px solid transparent; border-radius: {RADIUS_M}px; padding: 0; text-align: left; }}
QPushButton#recentBuildRow:hover {{ background: {SUBTLE}; }}
QPushButton#recentBuildRow:checked {{ background: {skin.selected}; border-color: {skin.accent}; }}
QPushButton#recentBuildRow:focus {{ border-color: {skin.focus}; }}
QFrame#recentBuildMarker {{ background: transparent; border: none; border-radius: 1px; }}
QFrame#recentBuildMarker[selected="true"] {{ background: {skin.accent}; }}
QLabel#recentBuildResult {{ color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; font-weight: {WEIGHT_BOLD}; }}
QLabel#recentBuildResult[result="Win"] {{ color: {SUCCESS}; }}
QLabel#recentBuildResult[result="Loss"] {{ color: {DANGER}; }}
QLabel#recentBuildName {{ color: {TEXT}; font-size: {TYPE_SMALL}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#recentBuildName[selected="true"] {{ color: {skin.accent}; }}
QLabel#recentBuildDetails {{ color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; }}
"""


def _build_chain(skin):
    return f"""
QWidget#companionBuildChain {{ background: transparent; }}
QLabel#chainIcon {{ background: {ELEVATED}; border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_M}px; color: {skin.accent}; }}
QLabel#chainName {{ color: {TEXT}; font-size: {TYPE_CAPTION}px; }}
QLabel#chainTime {{ color: {skin.accent}; font-size: {TYPE_SMALL}px; font-weight: {WEIGHT_SEMIBOLD}; }}
QLabel#chainTiming {{ background: {SUBTLE}; border-radius: {RADIUS_S}px; color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; padding: 1px {SPACE_XS}px; }}
QLabel#chainArrow {{ color: {TEXT_DIM}; font-size: {TYPE_TITLE}px; font-weight: {WEIGHT_BOLD}; }}
QLabel#chainSummary, QLabel#chainEmpty {{ color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; background: transparent; }}
QPushButton#chainMore {{ background: {BUTTON}; color: {TEXT}; border: 1px solid {BORDER_STRONG}; border-radius: {RADIUS_M}px; padding: {SPACE_XS}px {SPACE_S}px; }}
QPushButton#chainMore:hover {{ background: {BUTTON_HOVER}; }}
QPushButton#chainMore:focus {{ border-color: {skin.focus}; }}
"""


_SECTIONS = (_base, window_controls_style, _shell, _content, _buttons, _inputs, _choices, _views, _overlays, _studio,
             _companion_page, _companion_console, _companion_ghost, _companion_builds, _recent_builds, _build_chain)


def stylesheet(skin=DEFAULT_SKIN):
    """The whole application stylesheet in ``skin``."""
    return "".join(section(skin) for section in _SECTIONS)


# A quoted url() is one token, since the install folder in it may hold a brace or a semicolon.
_QSS_TOKEN = re.compile(r'"[^"]*"|[{};]|[^{};"]+')


def _rules(style):
    """``(selector, [declaration, ...])`` for each rule of a stylesheet built here."""
    selector, declarations, text = "", [], ""
    for token in _QSS_TOKEN.findall(style):
        if token == "{":
            selector, declarations, text = " ".join(text.split()), [], ""
        elif token in ";}":
            if text.strip():
                declarations.append(text.strip())
            text = ""
            if token == "}":
                yield selector, declarations
        else:
            text += token


def skin_layer(name):
    """The declarations where skin ``name`` differs from the default, to append after ``STYLE``.

    Only colours that belong to a skin change, so appending this to any
    stylesheet never moves, resizes or re-fonts a widget.
    """
    skin = SKINS.get(name, DEFAULT_SKIN)
    if skin == DEFAULT_SKIN:
        return ""
    layer = []
    for (selector, base), (_same, own) in zip(_rules(STYLE), _rules(stylesheet(skin))):
        changed = [declaration for declaration, original in zip(own, base) if declaration != original]
        if changed:
            layer.append(f"{selector} {{ {'; '.join(changed)}; }}")
    return "\n".join(layer) + "\n"


STYLE = stylesheet()
WINDOW_CONTROLS_STYLE = window_controls_style(DEFAULT_SKIN)
COMPANION_PAGE_STYLE = _companion_page(DEFAULT_SKIN)
COMPANION_CONSOLE_STYLE = _companion_console(DEFAULT_SKIN)
COMPANION_GHOST_STYLE = _companion_ghost(DEFAULT_SKIN)
COMPANION_BUILDS_STYLE = _companion_builds(DEFAULT_SKIN)
RECENT_BUILDS_STYLE = _recent_builds(DEFAULT_SKIN)
BUILD_CHAIN_STYLE = _build_chain(DEFAULT_SKIN)
