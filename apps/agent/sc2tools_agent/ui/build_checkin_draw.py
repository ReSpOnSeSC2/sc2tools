"""A Randomizer draw as a still on the loading card.

It sits under the saved pick, in the strip or in the slim "Locked in" bar:
the build's first steps, then its opening unit, or both units of a
two-Gateway or two-building opener (``build_checkin.randomizer_draw``).
Units drawn without a build sit in the strip under their own label and
stay in the bar whatever build is played. Plain labels only: no timer, no
animation and no sound, so the card repaints once, when the draw arrives,
and never again for it.
"""

from __future__ import annotations

from typing import Optional, Sequence

from PySide6 import QtWidgets

from ..build_checkin.randomizer_draw import DrawStep, RandomizerDraw
from . import theme
from .build_checkin_widgets import plain_label
from .companion_build_chain import entity_name


def step_line(step: DrawStep) -> str:
    """``0:18 · 14 Pylon``; a part the build does not store is left out."""
    what = " ".join(part for part in (step.supply, entity_name(step.action)) if part)
    return f"{step.time} \N{MIDDLE DOT} {what}" if step.time else what


UNITS_ALONE_LABEL = "\N{GAME DIE} Randomizer: opening units"
"""The strip's label over units drawn without a build."""


def units_line(units: Sequence[str], race: Optional[str]) -> str:
    """The widget's wording: a Protoss pair names each Gateway, another
    race's pair its order."""
    if len(units) == 2:
        if race == "Protoss":
            return f"Opening pair: Gate 1 {units[0]}, Gate 2 {units[1]}"
        return f"Opening pair: {units[0]}, then {units[1]}"
    return f"First unit: {units[0]}"


class RandomizerDrawStill(QtWidgets.QWidget):
    """Steps and units of one saved pick; hidden when there is neither."""

    def __init__(self) -> None:
        super().__init__()
        self.setObjectName("checkinDraw")
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(theme.SPACE_2XS)
        self.steps = plain_label("", "checkinDrawSteps", wrap=True)
        # A label's accessible name is its text unless one is set, so the
        # steps themselves are read; the description only adds context.
        self.steps.setAccessibleDescription("First steps of the drawn build")
        layout.addWidget(self.steps)
        self.units = plain_label("", "checkinDrawUnits", wrap=True)
        layout.addWidget(self.units)
        self.draw: Optional[RandomizerDraw] = None
        self.hide()

    def show_draw(self, draw: Optional[RandomizerDraw]) -> None:
        """Paint ``draw``; ``None`` or an empty draw hides the still."""
        if draw is not None and draw.empty:
            draw = None
        if draw == self.draw:
            return
        self.draw = draw
        if draw is None:
            self.hide()
            return
        self.steps.setText("\n".join(step_line(step) for step in draw.steps))
        self.steps.setVisible(bool(draw.steps))
        self.units.setText(units_line(draw.units, draw.race) if draw.units else "")
        self.units.setVisible(bool(draw.units))
        self.show()


__all__ = ["RandomizerDrawStill", "UNITS_ALONE_LABEL", "step_line", "units_line"]
