"""A persistent update card whose notes and actions survive transient notices."""

def build_update_card(parent, *, QtCore, QtWidgets, install, later, download, help_button):
    from PySide6 import QtGui
    from . import palette
    from .qt_helpers import build_flow_layout

    def arrow_icon(expanded):
        pixmap = QtGui.QPixmap(12, 12)
        pixmap.fill(QtCore.Qt.transparent)
        painter = QtGui.QPainter(pixmap)
        painter.setPen(QtCore.Qt.NoPen)
        painter.setBrush(QtGui.QColor(palette.CYAN))
        points = ((2, 3), (10, 3), (6, 9)) if expanded else ((3, 2), (9, 6), (3, 10))
        painter.drawPolygon(QtGui.QPolygon([QtCore.QPoint(x, y) for x, y in points]))
        painter.end()
        return QtGui.QIcon(pixmap)

    class UpdateCard(QtWidgets.QFrame):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("cardElevated")
            layout = QtWidgets.QVBoxLayout(self)
            self.title = QtWidgets.QLabel()
            self.title.setObjectName("h2")
            layout.addWidget(self.title)
            self.message = QtWidgets.QLabel()
            self.message.setWordWrap(True)
            layout.addWidget(self.message)
            row = build_flow_layout(QtCore=QtCore, QtWidgets=QtWidgets)
            self.notes_button = QtWidgets.QPushButton("What's new")
            self.notes_button.setCheckable(True)
            self.notes_button.setIcon(arrow_icon(False))
            self.notes_button.toggled.connect(lambda shown: self.notes_button.setIcon(arrow_icon(shown)))
            row.addWidget(self.notes_button)
            self.install_button = QtWidgets.QPushButton("Install now")
            self.install_button.setObjectName("primary")
            self.install_button.clicked.connect(install)
            row.addWidget(self.install_button)
            self.later_button = QtWidgets.QPushButton("Later")
            self.later_button.clicked.connect(later)
            row.addWidget(self.later_button)
            self.download_button = QtWidgets.QPushButton("Download installer")
            self.download_button.clicked.connect(download)
            row.addWidget(self.download_button)
            row.addWidget(help_button)
            layout.addLayout(row)
            self.notes = QtWidgets.QTextBrowser()
            self.notes.setOpenExternalLinks(True)
            self.notes.setMaximumHeight(220)
            self.notes_button.toggled.connect(self.notes.setVisible)
            layout.addWidget(self.notes)
            self.notes.hide()
            self.hide()

        def apply(self, release, state, detail):
            self.title.setText(f"Version {release.latest} is ready")
            self.notes.setMarkdown(release.release_notes or "No release notes were provided.")
            self.message.setText("Update failed: " + detail if state=="failed" else detail)
            self.message.setVisible(bool(detail))
            self.install_button.setText("Retry" if state=="failed" else "Install now")
            self.install_button.setEnabled(state!="installing")
            self.later_button.setEnabled(state!="installing")
            self.download_button.setVisible(state=="failed")
            self.show()
    return UpdateCard()
