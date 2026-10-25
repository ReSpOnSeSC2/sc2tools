"""Shared build-vs-build cards for the Companion and floating scouting report."""
from __future__ import annotations

from .companion_build_chain import build_build_chain


def build_scouting_comparison(parent, *, QtCore, QtGui, QtWidgets, icon_provider):
    class ScoutingComparison(QtWidgets.QWidget):
        ghostRequested = QtCore.Signal(str)

        def __init__(self):
            super().__init__(parent)
            self.setMinimumWidth(0)
            self.build_chains, self.upgrade_chains = {}, {}
            self.upgrade_headings, self.chain_labels, self.chain_headings = {}, {}, {}
            self.chain_reference_buttons, self.chain_cards = {}, []
            self.chain_cards_layout = QtWidgets.QGridLayout(self)
            self.chain_cards_layout.setContentsMargins(0, 0, 0, 0)
            self.chain_cards_layout.setSpacing(10)
            self._density = "detailed"
            self._stacked = None
            self._references = {}
            for position, (side, title) in enumerate((("my", "YOUR BUILD ORDER"), ("opp", "OPPONENT BUILD ORDER"))):
                card = QtWidgets.QFrame()
                card.setObjectName("companionCard")
                layout = QtWidgets.QVBoxLayout(card)
                heading = self._label(title, "Accent")
                build_name = self._label("Unclassified build", "Heading")
                layout.addWidget(heading)
                layout.addWidget(build_name)
                chain = build_build_chain(card, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_provider=icon_provider)
                layout.addWidget(chain, 1)
                upgrade_heading = self._label("UPGRADES · OBSERVED TIMINGS", "Accent")
                upgrades = build_build_chain(card, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_provider=icon_provider)
                upgrades.setMaximumHeight(180)
                layout.addWidget(upgrade_heading)
                layout.addWidget(upgrades)
                button = QtWidgets.QPushButton("☆ Use this build as Ghost")
                button.setMinimumWidth(0)
                button.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Fixed)
                selected_side = "you" if side == "my" else "opponent"
                button.clicked.connect(lambda _checked=False, chosen=selected_side: self.ghostRequested.emit(chosen))
                layout.addWidget(button)
                self.chain_headings[side], self.chain_labels[side] = heading, build_name
                self.build_chains[side], self.upgrade_chains[side] = chain, upgrades
                self.upgrade_headings[side] = upgrade_heading
                self.chain_reference_buttons[selected_side] = button
                self.chain_cards.append(card)
                self.chain_cards_layout.addWidget(card, 0, position)
                self.chain_cards_layout.setColumnStretch(position, 1)
                self._references[selected_side] = (False, False)
            self.set_density("detailed")

        def _label(self, text, kind):
            label = QtWidgets.QLabel(text)
            label.setTextFormat(QtCore.Qt.PlainText)
            label.setWordWrap(True)
            label.setMinimumWidth(0)
            label.setObjectName("companion" + kind)
            return label

        def set_density(self, density):
            self._density = density
            standard = density == "standard"
            for card in self.chain_cards:
                card.layout().setContentsMargins(*(8, 8, 8, 8) if standard else (12, 12, 12, 12))
                card.layout().setSpacing(4 if standard else 8)
            for side in self.build_chains:
                self.upgrade_chains[side].setVisible(density == "detailed")
                self.upgrade_headings[side].setVisible(density == "detailed")
                self.chain_headings[side].setText(("YOU" if side == "my" else "OPPONENT") if standard else
                                                 ("YOUR BUILD ORDER" if side == "my" else "OPPONENT BUILD ORDER"))
                label = self.chain_labels[side]
                label.setWordWrap(not standard)
                label.setMaximumHeight(20 if standard else 16777215)
                label.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
                label.setStyleSheet("font-size: 12px; font-weight: 600;" if standard else "")
                self.build_chains[side].setMinimumHeight(156 if standard else 166)
                self.build_chains[side].set_tile_width(80 if standard else None)
            self._reflow_cards()
            self._refresh_references()

        def _reflow_cards(self):
            # Keep two readable steps in each card. At the smallest panel
            # widths, put the cards one above the other rather than squeezing
            # both builds into single-icon columns.
            scrollbar = self.style().pixelMetric(QtWidgets.QStyle.PM_ScrollBarExtent)
            frame = max(card.frameWidth() for card in self.chain_cards)
            minimum_card = 2 * 80 + 8 + 4 + scrollbar + 2 * (frame + (8 if self._density == "standard" else 12))
            stacked = self.width() < 2 * minimum_card + self.chain_cards_layout.spacing()
            if stacked == self._stacked:
                return
            self._stacked = stacked
            for card in self.chain_cards:
                self.chain_cards_layout.removeWidget(card)
            for index, card in enumerate(self.chain_cards):
                self.chain_cards_layout.addWidget(card, index if stacked else 0, 0 if stacked else index)
            self.chain_cards_layout.setColumnStretch(1, 0 if stacked else 1)
            self.updateGeometry()

        def set_reference(self, side, *, selected, enabled):
            self._references[side] = (selected, enabled)
            self._refresh_references()

        def _refresh_references(self):
            compact = self._density == "standard" or self.width() < 480
            for side, (selected, enabled) in self._references.items():
                button = self.chain_reference_buttons[side]
                button.setText(("★ " if selected else "☆ ") + ("Ghost" if compact else "Use this build as Ghost"))
                button.setToolTip("Clear this Ghost reference" if selected else "Use this entire stored build as the Ghost reference")
                button.setEnabled(enabled)

        def resizeEvent(self, event):
            super().resizeEvent(event)
            self._reflow_cards()
            self._refresh_references()

        def set_side(self, side, name, events, horizon):
            standard = self._density == "standard"
            self.chain_labels[side].setText(str(name or "Unclassified build"))
            self.chain_labels[side].setToolTip(str(name or "Unclassified build"))
            chain = self.build_chains[side]
            chain.set_time_range(horizon)
            chain.set_events(events)
            chain.set_density(self._density)
            chain.summary.setWordWrap(not standard)
            chain.summary.setMaximumHeight(16 if standard else 16777215)
            chain.summary.setSizePolicy(QtWidgets.QSizePolicy.Ignored,
                                        QtWidgets.QSizePolicy.Fixed if standard else QtWidgets.QSizePolicy.Preferred)
            chain.summary.setToolTip(chain.summary.text())
            self.upgrade_chains[side].set_time_range(horizon)
            self.upgrade_chains[side].set_events([event for event in events if event["kind"] == "upgrade"])

    return ScoutingComparison()
