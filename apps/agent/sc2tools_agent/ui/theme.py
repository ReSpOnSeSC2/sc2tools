"""Qt-free visual tokens and application styles for the Companion desktop."""
from __future__ import annotations

from pathlib import Path

from . import palette


BG = "#100b19"
SURFACE = "#151021"
ELEVATED = "#21172e"
SUBTLE = "#30213e"
TEXT = "#f0e8ff"
TEXT_MUTED = "#ba9ed4"
TEXT_DIM = "#8f7da3"
ACCENT = "#b87be6"
ACCENT_HOVER = "#cf9cf2"
ACCENT_CYAN = "#71e2d2"
BORDER = "#341b50"
BORDER_STRONG = "#76508f"
BUTTON = "#42205d"
BUTTON_HOVER = "#62317f"
BUTTON_CHECKED = "#8146a3"
FOCUS = "#a8f3ec"
SUCCESS = palette.GREEN
WARNING = palette.AMBER
DANGER = palette.RED
INFO = palette.CYAN
CONSOLE_GRADIENT = "qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #7737b3,stop:0.5 #56218a,stop:1 #9146c8)"
CONTROL_ICONS = {
    name: (Path(__file__).resolve().parent / "assets" / "controls" / f"{name}.svg").as_posix()
    for name in ("check", "dash", "radio-dot", "chevron-down", "chevron-up")
}

WINDOW_CONTROLS_STYLE = f"""
QToolButton#windowMinimize, QToolButton#windowMaximize, QToolButton#windowClose {{
    background: {BUTTON}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    border-radius: 5px; padding: 0; margin: 0; min-width: 0; min-height: 0;
    font-family: 'Segoe UI', sans-serif; font-size: 17px; font-weight: 500;
}}
QToolButton#windowMinimize:hover, QToolButton#windowMaximize:hover {{
    background: {BUTTON_HOVER}; border-color: {ACCENT_HOVER};
}}
QToolButton#windowClose:hover {{ background: #8c345d; border-color: {DANGER}; }}
QToolButton#windowMinimize:focus, QToolButton#windowMaximize:focus, QToolButton#windowClose:focus {{
    border-color: {FOCUS};
}}
"""


STYLE = f"""
QWidget {{
    background: transparent;
    color: {TEXT};
    font-family: 'Segoe UI', 'Inter', system-ui, -apple-system, Arial, sans-serif;
    font-size: 13px;
}}
QLabel, QCheckBox, QRadioButton {{ background: transparent; }}
QWidget:disabled {{ color: {TEXT_DIM}; }}
QMainWindow, QWidget#agentRoot {{ background: {BG}; }}
QFrame#agentFrame {{
    background: {CONSOLE_GRADIENT};
    border: 2px solid {ACCENT};
    border-radius: 18px;
}}
QFrame#agentFrame[companion="true"], QFrame#agentDisplay[companion="true"] {{
    background: transparent;
    border: none;
    border-radius: 0;
}}
QWidget#agentBrandbar, QWidget#agentPageToolbar {{ background: transparent; border: none; }}
QLabel#agentBrand {{ font-size: 18px; font-weight: 800; letter-spacing: 2px; }}
QLabel#agentEdition {{ color: {TEXT_MUTED}; font-size: 10px; letter-spacing: 2px; }}
QLabel#agentBrandOrb {{ background: {ACCENT_CYAN}; border: 2px solid {FOCUS}; border-radius: 11px; }}
QLabel#agentBreadcrumb {{ color: {TEXT_MUTED}; font-size: 12px; }}
QFrame#agentSidebar, QFrame#agentDisplay {{
    background: {SURFACE};
    border: 2px solid {BORDER};
    border-radius: 10px;
}}
QFrame#sidebar {{ background: {SURFACE}; border-right: 1px solid {BORDER}; }}
QStackedWidget, QStackedWidget > QWidget {{ background: {SURFACE}; }}
QScrollArea {{ background: {SURFACE}; border: none; }}
QScrollArea > QWidget > QWidget {{ background: {SURFACE}; }}
QFrame#card, QFrame#studioCard, QFrame#studioDestination {{
    background: {SURFACE}; border: 1px solid {BORDER_STRONG}; border-radius: 12px;
}}
QFrame#cardElevated, QFrame#studioCommand {{
    background: {ELEVATED}; border: 1px solid {BORDER_STRONG}; border-radius: 12px;
}}
QFrame#cardArchive {{
    background: rgba(184, 123, 230, 0.10); border: 1px solid {ACCENT}; border-radius: 10px;
}}
QLabel#h1 {{ font-size: 25px; font-weight: 700; color: #e6d3fb; }}
QLabel#h2 {{ font-size: 17px; font-weight: 600; color: #e8dcff; }}
QLabel#muted {{ color: {TEXT_MUTED}; }}
QLabel#dim {{ color: {TEXT_DIM}; }}
QLabel#stat {{ font-size: 24px; font-weight: 700; color: {TEXT}; }}
QLabel#settingsToastOk {{ color: {SUCCESS}; }}
QLabel#settingsToastErr, QLabel#fieldError, QLabel#error {{ color: {DANGER}; }}
QLabel#code {{
    font-family: 'Cascadia Mono', 'Consolas', 'Menlo', monospace;
    font-size: 44px; font-weight: 700; letter-spacing: 8px;
    color: {ACCENT_HOVER}; background: {SUBTLE};
    border: 1px solid {BORDER_STRONG}; border-radius: 8px; padding: 14px 24px;
}}
QLabel#badgeInfo, QLabel#badgeOk, QLabel#badgeWarn, QLabel#badgeErr, QLabel#badgeNeutral {{
    border-radius: 10px; padding: 4px 10px; font-weight: 600;
}}
QLabel#badgeInfo {{ color: {INFO}; background: rgba(59, 195, 202, 0.15); }}
QLabel#badgeOk {{ color: {SUCCESS}; background: rgba(62, 192, 122, 0.16); }}
QLabel#badgeWarn {{ color: {WARNING}; background: rgba(230, 180, 80, 0.16); }}
QLabel#badgeErr {{ color: {DANGER}; background: rgba(255, 107, 107, 0.16); }}
QLabel#badgeNeutral {{ color: {ACCENT_HOVER}; background: rgba(184, 123, 230, 0.16); }}
QPushButton, QToolButton {{
    background: {BUTTON}; color: #f4e9ff;
    border: 1px solid #9164b0; border-radius: 6px;
    padding: 7px 10px; font-weight: 600;
}}
QPushButton {{ min-height: 20px; text-align: center; }}
QPushButton:hover, QToolButton:hover {{ background: {BUTTON_HOVER}; border-color: {ACCENT_HOVER}; }}
QPushButton:pressed, QToolButton:pressed {{ background: {SUBTLE}; border-color: {FOCUS}; }}
QPushButton:checked, QToolButton:checked {{ background: {BUTTON_CHECKED}; border-color: #deb6fa; }}
QPushButton:focus, QToolButton:focus {{ border-color: {FOCUS}; }}
QPushButton#primary {{ background: {BUTTON_CHECKED}; border-color: {ACCENT_HOVER}; color: {TEXT}; }}
QPushButton#primary:hover {{ background: {BUTTON_HOVER}; border-color: {FOCUS}; }}
QPushButton#primary:focus {{ border-color: {FOCUS}; }}
QPushButton#danger, QPushButton#dangerButton {{ color: {DANGER}; border-color: rgba(241, 109, 109, 0.55); }}
QPushButton#danger:hover, QPushButton#dangerButton:hover {{ background: rgba(241, 109, 109, 0.10); border-color: {DANGER}; }}
QPushButton#navItem {{
    background: transparent; color: {TEXT_MUTED}; border: 1px solid transparent;
    border-radius: 6px; padding: 9px 14px; text-align: left;
}}
QPushButton#navItem:hover {{ background: {BUTTON}; color: {TEXT}; border-color: {BORDER_STRONG}; }}
QPushButton#navItem:checked {{ background: {BUTTON_CHECKED}; color: {TEXT}; border-color: {ACCENT_HOVER}; }}
QPushButton#navItem:focus, QPushButton#navItem:checked:focus {{ border-color: {FOCUS}; }}
QPushButton#quietButton {{ background: transparent; color: {TEXT_MUTED}; border-color: transparent; padding: 6px 10px; }}
QPushButton#quietButton:hover {{ background: {SUBTLE}; color: {TEXT}; border-color: {BORDER_STRONG}; }}
QPushButton#quietButton:focus {{ border-color: {FOCUS}; }}
QToolButton#helpLink {{
    border: 1px solid {BORDER_STRONG}; border-radius: 10px; color: {TEXT_MUTED};
    padding: 0; min-width: 0; min-height: 0;
}}
QToolButton#helpLink:focus {{ border-color: {FOCUS}; }}
QPushButton:disabled, QToolButton:disabled,
QPushButton#primary:disabled, QPushButton#danger:disabled, QPushButton#dangerButton:disabled,
QPushButton#navItem:disabled, QPushButton#quietButton:disabled {{
    background: #251b30; color: #786486; border-color: #44304f;
}}
QLineEdit, QComboBox, QPlainTextEdit, QTextEdit, QTextBrowser, QAbstractSpinBox {{
    background: {ELEVATED}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    border-radius: 6px; padding: 7px 10px;
    selection-background-color: {BUTTON_CHECKED}; selection-color: {TEXT};
}}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus, QTextEdit:focus,
QTextBrowser:focus, QAbstractSpinBox:focus {{ border-color: {FOCUS}; }}
QLineEdit:disabled, QComboBox:disabled, QPlainTextEdit:disabled, QTextEdit:disabled,
QTextBrowser:disabled, QAbstractSpinBox:disabled {{ background: {SURFACE}; color: {TEXT_DIM}; border-color: {BORDER}; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox {{ padding-right: 28px; }}
QComboBox::down-arrow {{ image: url("{CONTROL_ICONS['chevron-down']}"); width: 16px; height: 16px; }}
QComboBox QAbstractItemView {{
    background: {ELEVATED}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    selection-background-color: {BUTTON_CHECKED}; selection-color: {TEXT};
}}
QAbstractSpinBox::up-button, QAbstractSpinBox::down-button {{ background: {BUTTON}; border: none; width: 18px; }}
QAbstractSpinBox {{ padding-right: 26px; }}
QAbstractSpinBox::up-button {{ subcontrol-origin: border; subcontrol-position: top right; }}
QAbstractSpinBox::down-button {{ subcontrol-origin: border; subcontrol-position: bottom right; }}
QAbstractSpinBox::up-button:hover, QAbstractSpinBox::down-button:hover {{ background: {BUTTON_HOVER}; }}
QAbstractSpinBox::up-arrow {{ image: url("{CONTROL_ICONS['chevron-up']}"); width: 12px; height: 12px; }}
QAbstractSpinBox::down-arrow {{ image: url("{CONTROL_ICONS['chevron-down']}"); width: 12px; height: 12px; }}
QCheckBox, QRadioButton {{ color: {TEXT}; spacing: 8px; }}
QCheckBox::indicator, QRadioButton::indicator {{
    width: 16px; height: 16px; border: 1px solid {BORDER_STRONG}; background: {ELEVATED};
}}
QCheckBox::indicator {{ border-radius: 3px; }}
QRadioButton::indicator {{ border-radius: 8px; }}
QCheckBox::indicator:hover, QRadioButton::indicator:hover {{ border-color: {ACCENT_HOVER}; }}
QCheckBox::indicator:checked, QRadioButton::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT_HOVER}; }}
QCheckBox::indicator:checked {{ image: url("{CONTROL_ICONS['check']}"); }}
QRadioButton::indicator:checked {{ image: url("{CONTROL_ICONS['radio-dot']}"); }}
QCheckBox::indicator:indeterminate {{ background: {BUTTON_CHECKED}; border-color: {ACCENT_HOVER}; image: url("{CONTROL_ICONS['dash']}"); }}
QCheckBox::indicator:focus, QRadioButton::indicator:focus {{ border-color: {FOCUS}; }}
QCheckBox:disabled, QRadioButton:disabled {{ color: {TEXT_DIM}; }}
QCheckBox::indicator:disabled, QRadioButton::indicator:disabled {{ background: {SURFACE}; border-color: {BORDER}; }}
QCheckBox::indicator:checked:disabled, QRadioButton::indicator:checked:disabled {{ background: {BORDER_STRONG}; }}
QTableView, QTableWidget, QTreeView, QTreeWidget, QListView, QListWidget {{
    background: {SURFACE}; alternate-background-color: {ELEVATED}; color: {TEXT};
    border: 1px solid {BORDER_STRONG}; border-radius: 7px;
    gridline-color: {BORDER}; selection-background-color: {BUTTON_CHECKED};
    selection-color: {TEXT}; outline: none;
}}
QTableView::item, QTableWidget::item, QTreeView::item, QTreeWidget::item, QListView::item, QListWidget::item {{
    padding: 6px 8px; border-bottom: 1px solid {BORDER};
}}
QTableView::item:hover, QTableWidget::item:hover, QTreeView::item:hover,
QTreeWidget::item:hover, QListView::item:hover, QListWidget::item:hover {{ background: {SUBTLE}; }}
QTableView::item:selected, QTableWidget::item:selected, QTreeView::item:selected,
QTreeWidget::item:selected, QListView::item:selected, QListWidget::item:selected {{ background: {BUTTON_CHECKED}; color: {TEXT}; }}
QTableView:focus, QTableWidget:focus, QTreeView:focus, QTreeWidget:focus,
QListView:focus, QListWidget:focus {{ border-color: {FOCUS}; }}
QTableView:disabled, QTableWidget:disabled, QTreeView:disabled, QTreeWidget:disabled,
QListView:disabled, QListWidget:disabled {{ color: {TEXT_DIM}; border-color: {BORDER}; }}
QHeaderView::section {{
    background: {SUBTLE}; color: {TEXT_MUTED}; border: none; border-bottom: 1px solid {BORDER_STRONG};
    padding: 8px; font-size: 11px; font-weight: 600;
}}
QTableCornerButton::section {{ background: {SUBTLE}; border: none; }}
QTabWidget::pane {{ background: {SURFACE}; border: 1px solid {BORDER_STRONG}; border-radius: 6px; }}
QTabBar::tab {{
    background: {ELEVATED}; color: {TEXT_MUTED}; border: 1px solid {BORDER};
    border-top-left-radius: 5px; border-top-right-radius: 5px;
    padding: 9px 14px; margin-right: 3px;
}}
QTabBar::tab:hover {{ background: {BUTTON}; color: {TEXT}; border-color: {BORDER_STRONG}; }}
QTabBar::tab:selected {{ background: {BUTTON_CHECKED}; color: {TEXT}; border-color: {ACCENT_HOVER}; }}
QTabBar::tab:focus {{ border-color: {FOCUS}; }}
QTabBar::tab:disabled {{ background: {SURFACE}; color: {TEXT_DIM}; border-color: {BORDER}; }}
QGroupBox {{
    background: {SURFACE}; border: 1px solid {BORDER_STRONG}; border-radius: 8px;
    margin-top: 14px; padding-top: 14px;
}}
QGroupBox::title {{ subcontrol-origin: margin; left: 12px; padding: 0 5px; color: {TEXT_MUTED}; }}
QProgressBar {{
    background: {ELEVATED}; color: {TEXT}; border: 1px solid {BORDER_STRONG};
    border-radius: 5px; text-align: center; min-height: 12px;
}}
QProgressBar::chunk {{ background: {BUTTON_CHECKED}; border-radius: 4px; }}
QProgressBar:disabled {{ color: {TEXT_DIM}; border-color: {BORDER}; }}
QProgressBar::chunk:disabled {{ background: {BORDER_STRONG}; }}
QSlider::groove:horizontal {{ background: {ELEVATED}; border: 1px solid {BORDER_STRONG}; height: 6px; border-radius: 3px; }}
QSlider::sub-page:horizontal {{ background: {ACCENT}; border-radius: 3px; }}
QSlider::handle:horizontal {{ background: {ACCENT_HOVER}; border: 1px solid {ACCENT}; width: 16px; margin: -5px 0; border-radius: 8px; }}
QSlider::groove:vertical {{ background: {ELEVATED}; border: 1px solid {BORDER_STRONG}; width: 6px; border-radius: 3px; }}
QSlider::add-page:vertical {{ background: {ACCENT}; border-radius: 3px; }}
QSlider::handle:vertical {{ background: {ACCENT_HOVER}; border: 1px solid {ACCENT}; height: 16px; margin: 0 -5px; border-radius: 8px; }}
QSlider::handle:hover, QSlider::handle:focus {{ border-color: {FOCUS}; }}
QSlider::handle:disabled {{ background: {TEXT_DIM}; border-color: {BORDER}; }}
QSlider::sub-page:horizontal:disabled, QSlider::add-page:vertical:disabled {{ background: {BORDER_STRONG}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 4px 2px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px 4px; }}
QScrollBar::handle:vertical {{ background: {BORDER_STRONG}; border-radius: 4px; min-height: 24px; }}
QScrollBar::handle:horizontal {{ background: {BORDER_STRONG}; border-radius: 4px; min-width: 24px; }}
QScrollBar::handle:vertical:hover, QScrollBar::handle:horizontal:hover {{ background: {ACCENT}; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical,
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{ background: transparent; }}
QSplitter::handle {{ background: {BORDER}; }}
QSplitter::handle:hover {{ background: {BORDER_STRONG}; }}
QPlainTextEdit#log {{
    font-family: 'Cascadia Mono', 'Consolas', 'Menlo', monospace;
    font-size: 12px; background: {BG}; color: {TEXT_MUTED};
    border: 1px solid {BORDER_STRONG}; border-radius: 8px;
}}
QPlainTextEdit#log:focus {{ border-color: {FOCUS}; }}
QWidget#studioContent, QScrollArea#streamStudio {{ background: {SURFACE}; }}
QWidget#studioTransparent {{ background: transparent; }}
QLineEdit#streamTitle {{ font-size: 19px; font-weight: 600; background: {BG}; border-color: {BORDER_STRONG}; padding: 8px 14px; }}
QLineEdit#streamTitle:focus {{ border-color: {FOCUS}; }}
QLabel#studioEyebrow {{ color: {TEXT_MUTED}; font-size: 10px; font-weight: 600; letter-spacing: 1px; }}
QLabel#studioCounter {{ color: {TEXT_MUTED}; font-size: 12px; }}
QLabel#studioNotice {{ color: {TEXT_MUTED}; font-size: 12px; }}
QLabel#studioDestinationTitle {{ font-size: 16px; font-weight: 600; color: {TEXT}; }}
QLabel#canvasLandscape, QLabel#canvasPortrait {{
    background: {ELEVATED}; color: {TEXT_MUTED}; border: 1px solid {BORDER_STRONG};
    border-radius: 5px; font-size: 10px; font-weight: 600;
}}
QLabel#studioBadge {{
    background: {SUBTLE}; color: {TEXT_MUTED}; border: 1px solid {BORDER_STRONG};
    border-radius: 8px; padding: 4px 9px; font-size: 11px; font-weight: 600;
}}
QLabel#studioBadge[tone="good"] {{ background: #143b33; border-color: #285b4e; color: #8be5bd; }}
QLabel#studioBadge[tone="live"] {{ background: #442831; border-color: #78404e; color: #ffabba; }}
QLabel#studioBadge[tone="warning"] {{ background: #3e3321; border-color: #665132; color: #f3cf8b; }}
QToolButton#studioDisclosureToggle {{
    background: {ELEVATED}; color: {TEXT_MUTED}; border: 1px solid {BORDER_STRONG};
    border-radius: 8px; text-align: left; padding: 11px 14px; font-weight: 600;
}}
QToolButton#studioDisclosureToggle:hover, QToolButton#studioDisclosureToggle:checked {{ background: {BUTTON}; color: {TEXT}; border-color: {ACCENT_HOVER}; }}
QToolButton#studioDisclosureToggle:focus {{ border-color: {FOCUS}; }}
QToolButton#studioDisclosureToggle:disabled {{ background: {SURFACE}; color: {TEXT_DIM}; border-color: {BORDER}; }}
QMenuBar {{ background: {SURFACE}; color: {TEXT}; }}
QMenuBar::item {{ background: transparent; padding: 6px 10px; }}
QMenuBar::item:selected {{ background: {BUTTON}; }}
QMenu {{ background: {SURFACE}; color: {TEXT}; border: 1px solid {BORDER_STRONG}; padding: 5px; }}
QMenu::item {{ padding: 7px 24px 7px 12px; border-radius: 4px; }}
QMenu::item:selected {{ background: {BUTTON_CHECKED}; color: {TEXT}; }}
QMenu::item:disabled {{ color: {TEXT_DIM}; }}
QMenu::separator {{ height: 1px; background: {BORDER_STRONG}; margin: 5px 6px; }}
QDialog, QMessageBox, QFileDialog, QInputDialog {{ background: {SURFACE}; color: {TEXT}; }}
QWidget#companionPanel, QWidget#ghostPanel {{ background: {SURFACE}; color: {TEXT}; }}
QWidget#checkinWindow {{ background: transparent; }}
QDialogButtonBox {{ background: transparent; }}
QToolTip {{
    background: {ELEVATED}; color: {TEXT}; border: 1px solid {ACCENT};
    border-radius: 5px; padding: 6px 9px;
}}
"""
