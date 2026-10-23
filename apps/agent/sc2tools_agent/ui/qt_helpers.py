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
