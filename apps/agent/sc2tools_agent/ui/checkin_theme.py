"""Stylesheet of the parentless build check-in cards.

The cards cannot inherit the application stylesheet (they have no parent
window), so they carry this compact copy built from the same tokens. The
Companion's build picker reuses the cards' rows with it.
"""

from __future__ import annotations

from .theme import (
    BORDER,
    BORDER_CONTROL,
    BORDER_STRONG,
    BUTTON,
    BUTTON_HOVER,
    BUTTON_PRESSED,
    CARD_PAGE_FILL,
    DANGER,
    DEFAULT_SKIN,
    ELEVATED,
    FONT_FAMILY,
    HAIRLINE_TOP,
    RADIUS_L,
    RADIUS_M,
    RADIUS_XL,
    SELECTED_TINT,
    SPACE_L,
    SPACE_M,
    SPACE_S,
    SPACE_XS,
    SUBTLE,
    SUCCESS,
    SUNKEN,
    SURFACE,
    TEXT,
    TEXT_DIM,
    TEXT_MUTED,
    TYPE_BODY,
    TYPE_CAPTION,
    TYPE_SMALL,
    TYPE_SUBTITLE,
    WARNING,
    WEIGHT_SEMIBOLD,
    blend,
    companion_builds_style,
    overlays_style,
)


def companion_builds_stylesheet(skin=DEFAULT_SKIN):
    return card_stylesheet(skin) + companion_builds_style(skin)


def card_stylesheet(skin=DEFAULT_SKIN):
    """Compact, self-contained theme for parentless build check-in cards."""
    return f"""
QWidget {{ background-color: transparent; color: {TEXT}; font-family: {FONT_FAMILY}; font-size: {TYPE_SMALL}px; }}
QFrame#card {{ background: {CARD_PAGE_FILL}; border: 1px solid {BORDER_STRONG}; border-top-color: {HAIRLINE_TOP}; border-radius: {RADIUS_XL}px; }}
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
QLabel#checkinDrawSteps {{ color: {TEXT_MUTED}; font-size: {TYPE_CAPTION}px; }}
QLabel#checkinDrawUnits {{ color: {skin.accent}; font-weight: {WEIGHT_SEMIBOLD}; }}
""" + overlays_style(skin)


def checkin_chip_colours(skin, tone):
    if tone == "rolled":
        return blend(WARNING, SURFACE, SELECTED_TINT), WARNING
    if tone == "usual":
        return SUBTLE, skin.accent
    return skin.selected, skin.accent
