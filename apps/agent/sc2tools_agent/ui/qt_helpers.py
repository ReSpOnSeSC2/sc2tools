"""Small GUI helpers; importing this module never imports Qt."""
from __future__ import annotations

import socket
import time
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

API_ADDRESS_ERROR = (
    "Enter a full address starting with https://, or leave it blank to use sc2tools.com."
)


def validate_api_base(text: str) -> Optional[str]:
    value = text.strip()
    if not value:
        return None
    if any(character.isspace() or ord(character) < 32 for character in value):
        return API_ADDRESS_ERROR
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        _ = parsed.port
    except ValueError:
        return API_ADDRESS_ERROR
    if host and (parsed.scheme == "https" or (
        parsed.scheme == "http" and host.lower() in {"localhost", "127.0.0.1", "::1"}
    )):
        return None
    return API_ADDRESS_ERROR


def probe_api_health(base: str) -> str:
    """Called by a worker, with no widgets and a bounded network timeout."""
    started = time.monotonic()
    try:
        with urlopen(base.rstrip("/") + "/v1/health", timeout=5) as response:
            status = response.status
        if status >= 400:
            return f"Couldn't reach that address (HTTP {status})"
        return f"Reachable · {round((time.monotonic() - started) * 1000)} ms"
    except HTTPError as exc:
        reason = f"HTTP {exc.code}"
    except (TimeoutError, socket.timeout):
        reason = "timeout"
    except URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            reason = "timeout"
        elif isinstance(exc.reason, socket.gaierror):
            reason = "name not found"
        else:
            reason = "connection failed"
    except OSError:
        reason = "connection failed"
    return f"Couldn't reach that address ({reason})"


def install_wheel_guard(widget, QtCore):
    """Unfocused value controls pass wheel input to their scroll area."""
    app = QtCore.QCoreApplication.instance()
    existing = getattr(app, "_sc2_value_wheel_guard", None)
    if existing is not None:
        widget.setFocusPolicy(QtCore.Qt.StrongFocus)
        if getattr(widget, "_sc2_wheel_guard", None) is None:
            widget._sc2_wheel_guard = existing
            widget.installEventFilter(existing)
        return existing

    class WheelGuard(QtCore.QObject):
        def eventFilter(self, watched, event):
            if event.type() == QtCore.QEvent.Wheel and not watched.hasFocus():
                # A combo popup owns its wheel input while open.
                view = getattr(watched, "view", lambda: None)()
                if view is not None and view.isVisible():
                    return False
                event.ignore()
                return True
            return False

    widget.setFocusPolicy(QtCore.Qt.StrongFocus)
    guard = WheelGuard(app or widget)
    if app is not None:
        app._sc2_value_wheel_guard = guard
    widget._sc2_wheel_guard = guard
    widget.installEventFilter(guard)
    return guard


def install_wheel_router(app, QtCore, QtWidgets):
    """Make the mouse wheel scroll whatever surface is under the pointer.

    One application-wide filter covers every window the agent opens (main
    window, Companion panels, check-in cards, scouting report, dialogs),
    including controls created after it is installed:

    - Value controls (combo boxes, spin and date boxes, sliders) never take
      keyboard focus from the wheel, and while unfocused they pass wheel
      input on to the nearest scroll area, so scrolling a page never edits
      a setting by accident. A control the player clicked or tabbed into
      keeps its own wheel behaviour, and an open combo list keeps the wheel
      for its items.
    - Tab bars pass the wheel on while unfocused instead of switching tabs.
    - Scroll bars, lists, tables and text views keep their native
      behaviour: they scroll themselves and hand the wheel to the page once
      they reach an end.
    Returns the installed filter; calling it again returns the same one.
    """
    existing = getattr(app, "_sc2_wheel_router", None)
    if existing is not None:
        return existing
    value_types = (QtWidgets.QComboBox, QtWidgets.QAbstractSpinBox, QtWidgets.QAbstractSlider)
    wheel_focus = QtCore.Qt.WheelFocus

    def _tame_focus(widget):
        if isinstance(widget, value_types) and not isinstance(widget, QtWidgets.QScrollBar):
            if (widget.focusPolicy() & wheel_focus) == wheel_focus:
                widget.setFocusPolicy(QtCore.Qt.StrongFocus)

    class WheelRouter(QtCore.QObject):
        def eventFilter(self, watched, event):
            kind = event.type()
            if kind == QtCore.QEvent.Polish:
                _tame_focus(watched)
                return False
            if kind != QtCore.QEvent.Wheel:
                return False
            if isinstance(watched, QtWidgets.QScrollBar):
                return False
            if isinstance(watched, QtWidgets.QComboBox):
                view = watched.view()
                if view is not None and view.isVisible():
                    return False
            elif not isinstance(watched, (QtWidgets.QAbstractSpinBox, QtWidgets.QAbstractSlider, QtWidgets.QTabBar)):
                return False
            if watched.hasFocus():
                return False
            # Ignored + filtered: Qt keeps offering the wheel to the parents,
            # so the enclosing scroll area scrolls.
            event.ignore()
            return True

    router = WheelRouter(app)
    app.installEventFilter(router)
    app._sc2_wheel_router = router
    for widget in app.allWidgets():
        _tame_focus(widget)
    return router


def guard_value_widgets(root, QtCore=None, QtWidgets=None):
    if QtCore is None or QtWidgets is None:
        from PySide6 import QtCore, QtWidgets
    for widget_type in (QtWidgets.QComboBox, QtWidgets.QAbstractSpinBox, QtWidgets.QAbstractSlider):
        for widget in root.findChildren(widget_type):
            # Scrollbars inherit QAbstractSlider too; guarding them would
            # consume the very page scrolling these controls must preserve.
            if isinstance(widget, QtWidgets.QScrollBar):
                continue
            install_wheel_guard(widget, QtCore)


def build_flow_layout(parent=None, *, QtCore, QtWidgets, spacing=8):
    class FlowLayout(QtWidgets.QLayout):
        def __init__(self):
            super().__init__(parent)
            self._items = []
            self.setContentsMargins(0, 0, 0, 0)
            self.setSpacing(spacing)

        def addItem(self, item):
            self._items.append(item)
            self.invalidate()

        def count(self):
            return len(self._items)

        def itemAt(self, index):
            return self._items[index] if 0 <= index < len(self._items) else None

        def takeAt(self, index):
            if 0 <= index < len(self._items):
                item = self._items.pop(index)
                self.invalidate()
                return item
            return None

        def expandingDirections(self):
            return QtCore.Qt.Orientations()

        def hasHeightForWidth(self):
            return True

        def heightForWidth(self, width):
            return self._arrange(QtCore.QRect(0, 0, width, 0), False)

        def minimumSize(self):
            size = QtCore.QSize()
            for item in self._items:
                if not item.isEmpty():
                    size = size.expandedTo(item.minimumSize())
            margins = self.contentsMargins()
            return size + QtCore.QSize(margins.left() + margins.right(), margins.top() + margins.bottom())

        def sizeHint(self):
            items = [item for item in self._items if not item.isEmpty()]
            margins = self.contentsMargins()
            width = sum(item.sizeHint().width() for item in items) + max(0, len(items) - 1) * self.spacing()
            height = max((item.sizeHint().height() for item in items), default=0)
            return QtCore.QSize(width + margins.left() + margins.right(), height + margins.top() + margins.bottom())

        def setGeometry(self, rectangle):
            super().setGeometry(rectangle)
            self._arrange(rectangle, True)

        def _arrange(self, rectangle, place):
            margins = self.contentsMargins()
            available = rectangle.adjusted(margins.left(), margins.top(), -margins.right(), -margins.bottom())
            left, top = available.x(), available.y()
            row_height = 0
            for item in self._items:
                if item.isEmpty():
                    continue
                hint = item.sizeHint().expandedTo(item.minimumSize())
                width = min(hint.width(), max(1, available.width()))
                height = max(hint.height(), item.heightForWidth(width)) if item.hasHeightForWidth() else hint.height()
                if left > available.x() and left + width > available.x() + available.width():
                    left = available.x()
                    top += row_height + self.spacing()
                    row_height = 0
                if place:
                    item.setGeometry(QtCore.QRect(left, top, width, height))
                left += width + self.spacing()
                row_height = max(row_height, height)
            return top - rectangle.y() + row_height + margins.bottom()

    return FlowLayout()


def page_description(text, QtWidgets):
    """The muted one-line purpose under the title of a page."""
    label = QtWidgets.QLabel(text)
    label.setObjectName("pageDescription")
    label.setWordWrap(True)
    return label


def scrolling_page(scroll, *, QtWidgets):
    """Make ``scroll`` a page that scrolls instead of squeezing its content; return its layout.

    The content keeps its own minimum height, so at the smallest window the
    page scrolls where a plain page would overlap its controls.
    """
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
    content = QtWidgets.QWidget()
    layout = QtWidgets.QVBoxLayout(content)
    scroll.setWidget(content)
    return layout


def install_responsive_forms(scroll, *, QtCore, QtWidgets, breakpoint=640):
    class ResponsiveForms(QtCore.QObject):
        def __init__(self):
            super().__init__(scroll)
            self._narrow = None
            self._closed = False
            self._viewport = scroll.viewport()
            self._viewport.installEventFilter(self)
            scroll.destroyed.connect(self._on_destroyed)
            self.refresh()

        def _on_destroyed(self, *_args):
            self._closed = True

        def refresh(self):
            if self._closed:
                return
            narrow = self._viewport.width() < breakpoint
            if narrow == self._narrow or scroll.widget() is None:
                return
            self._narrow = narrow
            for form in scroll.widget().findChildren(QtWidgets.QFormLayout):
                form.setRowWrapPolicy(QtWidgets.QFormLayout.WrapAllRows if narrow else QtWidgets.QFormLayout.WrapLongRows)
                form.setLabelAlignment(QtCore.Qt.AlignLeft | QtCore.Qt.AlignVCenter)

        def eventFilter(self, watched, event):
            if not self._closed and watched is self._viewport and event.type() in (QtCore.QEvent.Resize, QtCore.QEvent.Show):
                self.refresh()
            return False

    return ResponsiveForms()
