"""Lazy-Qt window controls and native drag/resize for the desktop console."""
from __future__ import annotations

from . import theme


def build_window_controls(parent, *, window, QtCore, QtWidgets):
    class WindowControls(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("windowControls")
            self.setStyleSheet(theme.WINDOW_CONTROLS_STYLE)
            layout = QtWidgets.QHBoxLayout(self)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(4)
            self.minimize_button = self._button("−", "windowMinimize", "Minimize window", window.showMinimized)
            self.maximize_button = self._button("□", "windowMaximize", "Maximize window", self._toggle_maximized)
            self.close_button = self._button("×", "windowClose", "Close window", window.close)
            for button in (self.minimize_button, self.maximize_button, self.close_button):
                layout.addWidget(button)
            window.installEventFilter(self)

        def _button(self, text, name, description, callback):
            button = QtWidgets.QToolButton(self)
            button.setText(text)
            button.setObjectName(name)
            button.setAccessibleName(description)
            button.setToolTip(description)
            button.setFixedSize(26, 24)
            button.setCursor(QtCore.Qt.PointingHandCursor)
            button.clicked.connect(callback)
            return button

        def _toggle_maximized(self):
            window.showNormal() if window.isMaximized() else window.showMaximized()

        def eventFilter(self, watched, event):
            if watched is window and event.type() == QtCore.QEvent.WindowStateChange:
                maximized = window.isMaximized()
                self.maximize_button.setText("❐" if maximized else "□")
                description = "Restore window" if maximized else "Maximize window"
                self.maximize_button.setAccessibleName(description)
                self.maximize_button.setToolTip(description)
            return super().eventFilter(watched, event)

    return WindowControls()


def install_window_interactions(window, *, drag_widgets, QtCore, QtWidgets, can_maximize=lambda: True):
    class WindowInteractions(QtCore.QObject):
        def __init__(self):
            super().__init__(window)
            self._drag_widgets = list(drag_widgets)
            self._cursor_widget = None
            self._previous_cursor = None
            self._application = QtWidgets.QApplication.instance()
            window.setMouseTracking(True)
            for widget in window.findChildren(QtWidgets.QWidget):
                widget.setMouseTracking(True)
            self._application.installEventFilter(self)

        def extend_drag_widgets(self, widgets):
            self._drag_widgets.extend(widget for widget in widgets if widget not in self._drag_widgets)

        def _clear_cursor(self):
            if self._cursor_widget is not None:
                try:
                    if self._previous_cursor is None:
                        self._cursor_widget.unsetCursor()
                    else:
                        self._cursor_widget.setCursor(self._previous_cursor)
                except RuntimeError:
                    pass
            self._cursor_widget = None
            self._previous_cursor = None

        def _drag_target(self, widget):
            interactive = (QtWidgets.QAbstractButton, QtWidgets.QAbstractSpinBox, QtWidgets.QComboBox,
                           QtWidgets.QLineEdit, QtWidgets.QAbstractItemView, QtWidgets.QTextEdit,
                           QtWidgets.QPlainTextEdit, QtWidgets.QAbstractSlider, QtWidgets.QMenu)
            current = widget
            while current is not None and current is not window:
                if isinstance(current, interactive):
                    return False
                if current in self._drag_widgets:
                    return True
                current = current.parentWidget()
            return False

        def _edges(self, position):
            edges = QtCore.Qt.Edges()
            if position.x() < 6:
                edges |= QtCore.Qt.LeftEdge
            elif position.x() >= window.width() - 6:
                edges |= QtCore.Qt.RightEdge
            if position.y() < 6:
                edges |= QtCore.Qt.TopEdge
            elif position.y() >= window.height() - 6:
                edges |= QtCore.Qt.BottomEdge
            return edges

        def eventFilter(self, watched, event):
            if not isinstance(watched, QtWidgets.QWidget) or watched.window() is not window:
                return False
            kind = event.type()
            if kind not in (QtCore.QEvent.MouseButtonPress, QtCore.QEvent.MouseButtonDblClick, QtCore.QEvent.MouseMove, QtCore.QEvent.Leave):
                return False
            if kind == QtCore.QEvent.Leave:
                if watched is self._cursor_widget:
                    self._clear_cursor()
                return False
            position = watched.mapTo(window, event.position().toPoint())
            edges = self._edges(position) if not window.isMaximized() and not window.isFullScreen() else QtCore.Qt.Edges()
            if kind == QtCore.QEvent.MouseMove:
                if self._cursor_widget is not None and self._cursor_widget is not watched:
                    self._clear_cursor()
                if edges:
                    if self._cursor_widget is not watched:
                        self._previous_cursor = watched.cursor() if watched.testAttribute(QtCore.Qt.WA_SetCursor) else None
                    horizontal = bool(edges & (QtCore.Qt.LeftEdge | QtCore.Qt.RightEdge))
                    vertical = bool(edges & (QtCore.Qt.TopEdge | QtCore.Qt.BottomEdge))
                    if horizontal and vertical:
                        same_diagonal = bool(edges & QtCore.Qt.LeftEdge) == bool(edges & QtCore.Qt.TopEdge)
                        cursor = QtCore.Qt.SizeFDiagCursor if same_diagonal else QtCore.Qt.SizeBDiagCursor
                    else:
                        cursor = QtCore.Qt.SizeHorCursor if horizontal else QtCore.Qt.SizeVerCursor
                    watched.setCursor(cursor)
                    self._cursor_widget = watched
                else:
                    self._clear_cursor()
                return False
            if event.button() != QtCore.Qt.LeftButton:
                return False
            handle = window.windowHandle()
            if kind == QtCore.QEvent.MouseButtonPress and edges and handle is not None:
                return bool(handle.startSystemResize(edges))
            if not self._drag_target(watched):
                return False
            if kind == QtCore.QEvent.MouseButtonDblClick:
                if can_maximize():
                    window.showNormal() if window.isMaximized() else window.showMaximized()
                return True
            return bool(handle.startSystemMove()) if handle is not None else False

    return WindowInteractions()
