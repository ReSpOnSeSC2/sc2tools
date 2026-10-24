"""Local-only positions for native Companion panels, without importing Qt."""
from __future__ import annotations

from copy import deepcopy
import time


PANEL_KINDS = frozenset({"opponent", "scouting", "session", "ghost"})


def normalize_panel_positions(value):
    if not isinstance(value, dict):
        return {}
    return {
        kind: list(point) for kind, point in value.items()
        if kind in PANEL_KINDS and isinstance(point, (list, tuple)) and len(point) == 2
        and all(type(coordinate) is int and abs(coordinate) < 1_000_000 for coordinate in point)
    }


def restored_panel_position(saved, default, size, screens):
    from .ui.build_checkin_window import clamp_card_position

    screens = list(screens)
    if saved is not None:
        point = clamp_card_position(tuple(saved), size, screens)
        if point is not None:
            return point
    point = clamp_card_position(tuple(default), size, screens)
    if point is not None:
        return point
    return tuple(screens[0][:2]) if screens else tuple(default)


def build_panel_position_manager(parent, *, panels, positions, defaults_provider,
                                 preview_provider, on_positions, QtCore, QtWidgets):
    class PanelPositions(QtCore.QObject):
        statusChanged = QtCore.Signal(str)

        def __init__(self):
            super().__init__(parent)
            self._panels = dict(panels)
            self._positions = normalize_panel_positions(positions)
            self._defaults = defaults_provider
            self._preview = preview_provider
            self._save = on_positions
            self._pending = {}
            self._dragging = None
            self._ignore_native_until = {}
            self._closed = False
            self._applying = False
            self.timer = QtCore.QTimer(self)
            self.timer.setSingleShot(True)
            self.timer.setInterval(350)
            self.timer.timeout.connect(self._flush)
            self._application = QtWidgets.QApplication.instance()
            self.restore_all()
            self._application.installEventFilter(self)
            self._application.screenRemoved.connect(self._screens_changed)

        def snapshot(self):
            return deepcopy(self._positions)

        def _kind(self, widget):
            if not isinstance(widget, QtWidgets.QWidget):
                return None
            window = widget.window()
            return next((kind for kind, panel in self._panels.items() if panel is window), None)

        def _eligible(self, kind):
            panel = self._panels[kind]
            return (panel.isVisible() and not panel.isMinimized() and not self._preview(kind)
                    and not panel.property("gameClickThrough"))

        def _restore(self, kind):
            from .ui.build_checkin_window import screen_rects

            panel = self._panels[kind]
            defaults = normalize_panel_positions(self._defaults())
            default = defaults.get(kind, [0, 0])
            position = restored_panel_position(self._positions.get(kind), default,
                                               (panel.width(), panel.height()), screen_rects(self._application.screens()))
            self._applying = True
            self._ignore_native_until[kind] = time.monotonic() + 0.25
            try:
                panel.move(*position)
            finally:
                self._applying = False

        def restore_all(self):
            if not self._closed:
                self.cancel_pending()
                for kind in self._panels:
                    self._restore(kind)

        def _screens_changed(self, _screen):
            if not self._closed:
                QtCore.QTimer.singleShot(0, self.restore_all)

        def cancel_pending(self):
            self.timer.stop()
            self._pending.clear()
            self._dragging = None
            for kind in self._panels:
                self._ignore_native_until[kind] = time.monotonic() + 0.25

        def _commit(self, positions):
            try:
                if callable(self._save):
                    self._save(deepcopy(positions))
            except Exception:
                self.statusChanged.emit("Panel positions could not be saved. Drag a panel again or reset positions to retry.")
                return False
            self._positions = deepcopy(positions)
            self.statusChanged.emit("")
            return True

        def _flush(self):
            if self._closed:
                return
            positions = dict(self._positions)
            positions.update(self._pending)
            self._pending.clear()
            if positions != self._positions:
                self._commit(positions)

        def reset(self):
            if self._closed:
                return False
            self.cancel_pending()
            if not self._commit({}):
                return False
            self.restore_all()
            self.statusChanged.emit("Panel positions reset on this PC.")
            return True

        def eventFilter(self, watched, event):
            if self._closed or self._applying:
                return False
            event_type = event.type()
            if event_type not in (QtCore.QEvent.MouseButtonPress, QtCore.QEvent.NonClientAreaMouseButtonPress,
                                   QtCore.QEvent.MouseButtonRelease, QtCore.QEvent.NonClientAreaMouseButtonRelease,
                                   QtCore.QEvent.Show, QtCore.QEvent.Hide, QtCore.QEvent.WindowStateChange, QtCore.QEvent.Move):
                return False
            kind = self._kind(watched)
            if event_type in (QtCore.QEvent.MouseButtonPress, QtCore.QEvent.NonClientAreaMouseButtonPress):
                self._dragging = None
                if kind is not None and self._eligible(kind) and event.button() == QtCore.Qt.LeftButton:
                    interactions = getattr(self._panels[kind], "_window_interactions", None)
                    if interactions is not None:
                        panel = self._panels[kind]
                        point = watched.mapTo(panel, event.position().toPoint())
                        if interactions._drag_target(watched) or interactions._edges(point):
                            self._dragging = kind
            elif event_type in (QtCore.QEvent.MouseButtonRelease, QtCore.QEvent.NonClientAreaMouseButtonRelease):
                self._dragging = None
            elif kind is not None and watched is self._panels[kind]:
                if event_type == QtCore.QEvent.Show and not watched.isMinimized():
                    self._restore(kind)
                elif event_type in (QtCore.QEvent.Hide, QtCore.QEvent.WindowStateChange):
                    if kind in self._pending:
                        self._flush()
                    if self._dragging == kind:
                        self._dragging = None
                elif event_type == QtCore.QEvent.Move and self._eligible(kind):
                    native_move = event.spontaneous() and time.monotonic() >= self._ignore_native_until.get(kind, 0)
                    if self._dragging == kind or native_move:
                        self._pending[kind] = [watched.x(), watched.y()]
                        self.timer.start()
            return False

        def shutdown(self):
            if not self._closed:
                self._flush()
                self.cancel_pending()
                self._closed = True
                self._application.removeEventFilter(self)
                try:
                    self._application.screenRemoved.disconnect(self._screens_changed)
                except (RuntimeError, TypeError):
                    pass

    return PanelPositions()
