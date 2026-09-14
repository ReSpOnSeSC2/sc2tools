"""Local, output-only SC2 loading/chat shield, owned by the Qt GUI thread.

The HTTP worker does no window work. The native backend does no game-memory
inspection. Only the pure policy's race field is ever rendered. Calibration
uses the actual game behind a transparent editor, never a sample screenshot.
"""

from __future__ import annotations

from dataclasses import replace
import logging
import math
import threading
import time
from typing import Callable, Optional

import requests
from PySide6 import QtCore, QtGui, QtWidgets

from ..blind_mode import BlindModeConfig, BlindModePolicy, NormalizedRect, normalized_ui_screens
from .blind_windows import BlindWindowsBackend, NativeGameWindow

log = logging.getLogger(__name__)
HOTKEY_LABEL = "Ctrl+Shift+F9"
_SAMPLE_MAX_AGE = 1.0
_POLL_INTERVAL = 0.1
_FULL_RECT = NormalizedRect(0, 0, 1, 1)


def pixel_rect(rect: NormalizedRect, game: NativeGameWindow) -> tuple[int, int, int, int]:
    """Round outwards so fractional DPI/scaling never leaves a one-pixel seam."""
    left = math.floor(rect.x * game.width)
    top = math.floor(rect.y * game.height)
    right = min(game.width, math.ceil((rect.x + rect.width) * game.width))
    bottom = min(game.height, math.ceil((rect.y + rect.height) * game.height))
    return game.x + left, game.y + top, right - left, bottom - top


class _Surface(QtWidgets.QWidget):
    def __init__(self) -> None:
        super().__init__(None, QtCore.Qt.Tool | QtCore.Qt.FramelessWindowHint
                         | QtCore.Qt.WindowStaysOnTopHint
                         | QtCore.Qt.WindowTransparentForInput
                         | QtCore.Qt.WindowDoesNotAcceptFocus)
        self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
        self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
        self.setAttribute(QtCore.Qt.WA_OpaquePaintEvent)
        self.setFocusPolicy(QtCore.Qt.NoFocus)
        self.setWindowTitle("SC2 Tools — Blind Ladder cover")
        self.curtain = False
        self.race: Optional[str] = None

    def set_content(self, curtain: bool, race: Optional[str]) -> None:
        if (curtain, race) != (self.curtain, self.race):
            self.curtain, self.race = curtain, race
            self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QtGui.QPainter(self)
        painter.fillRect(self.rect(), QtGui.QColor("#0b0d12"))
        if not self.curtain:
            return
        painter.setRenderHint(QtGui.QPainter.TextAntialiasing)
        font = QtGui.QFont("Segoe UI", 13)
        painter.setFont(font)
        painter.setPen(QtGui.QColor("#9aa3b2"))
        center = self.height() // 2
        painter.drawText(QtCore.QRect(24, center - 74, self.width() - 48, 32),
                         QtCore.Qt.AlignCenter, "OPPONENT RACE")
        font.setPointSize(32)
        font.setWeight(QtGui.QFont.DemiBold)
        painter.setFont(font)
        painter.setPen(QtGui.QColor("#e6e8ee"))
        painter.drawText(QtCore.QRect(24, center - 30, self.width() - 48, 68),
                         QtCore.Qt.AlignCenter, self.race or "Not available yet")
        # No opponent-dependent color, portrait, sound, rating or other cues.
        font.setPointSize(11)
        font.setWeight(QtGui.QFont.Normal)
        painter.setFont(font)
        painter.setPen(QtGui.QColor("#9aa3b2"))
        painter.drawText(QtCore.QRect(24, self.height() - 54, self.width() - 48, 28),
                         QtCore.Qt.AlignCenter, f"Blind Ladder  ·  {HOTKEY_LABEL} turns protection off")


class _HotkeyFilter(QtCore.QAbstractNativeEventFilter):
    def __init__(self, controller) -> None:
        super().__init__()
        self.controller = controller

    def nativeEventFilter(self, event_type, message):  # noqa: N802
        if bytes(event_type) in (b"windows_generic_MSG", b"windows_dispatcher_MSG") and \
                self.controller._backend.consume_native_message(int(message)):
            # Defer QWidget/state mutation until Qt finishes native dispatch.
            QtCore.QTimer.singleShot(0, self.controller._emergency_off)
            return True, 0
        return False, 0


class BlindShieldController(QtCore.QObject):
    statusChanged = QtCore.Signal(str)
    _sampleReady = QtCore.Signal(object, int)

    def __init__(
        self, parent=None, *, initial_enabled: bool = False, config: Optional[dict] = None,
        user_name_hint: Optional[str] = None,
        on_enabled_changed: Optional[Callable[[bool], bool]] = None,
        backend=None, clock: Callable[[], float] = time.monotonic, session_factory=None,
    ) -> None:
        super().__init__(parent)
        self._backend = backend if backend is not None else BlindWindowsBackend()
        self._clock = clock
        self._session_factory = session_factory or requests.Session
        self._config = replace(BlindModeConfig.from_dict(config), enabled=initial_enabled is True)
        self._policy = BlindModePolicy(self._config, user_name_hint)
        self._on_enabled_changed = on_enabled_changed
        self._user_name_hint = user_name_hint
        self._enabled = initial_enabled is True
        self._surfaces: list[_Surface] = []
        self._banks: list[list[_Surface]] = [[], []]
        self._active_bank = 0
        self._render_signature = None
        self._stop_event = threading.Event()
        self._poll_event = threading.Event()
        self._epoch_lock = threading.Lock()
        self._epoch = 0
        self._thread: Optional[threading.Thread] = None
        self._started = False
        self._calibrating = False
        self._dialog = None
        self._last_sample_at: Optional[float] = None
        self._last_status = ""
        self._last_hwnd: Optional[int] = None
        self._hotkey_registered = False
        self._next_hotkey_attempt = 0.0
        self._emergency_notice = ""
        self._filter = _HotkeyFilter(self)
        self._timer = QtCore.QTimer(self)
        self._timer.setInterval(50)
        self._timer.timeout.connect(self._tick)
        self._sampleReady.connect(self._receive_sample)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        if not self._backend.available:
            self._status("Unavailable — native Blind Ladder requires Windows.")
            return
        self._stop_event.clear()
        app = QtWidgets.QApplication.instance()
        if app is not None:
            app.installNativeEventFilter(self._filter)
        self._thread = threading.Thread(target=self._poll, name="sc2-blind-local", daemon=True)
        self._thread.start()
        self._timer.start()
        self._tick()

    def stop(self) -> None:
        self._started = False
        self._timer.stop()
        self._stop_event.set()
        self._poll_event.set()
        with self._epoch_lock:
            self._epoch += 1
        self._hide_all()
        if self._dialog is not None:
            self._dialog.reject()
        app = QtWidgets.QApplication.instance()
        if app is not None:
            app.removeNativeEventFilter(self._filter)
        self._backend.close()
        self._hotkey_registered = False
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None
        for surface in self._surfaces:
            surface.close()
            surface.deleteLater()
        self._surfaces.clear()
        self._banks = [[], []]
        self._render_signature = None

    def set_enabled(self, enabled: bool) -> None:
        enabled = enabled is True
        self._emergency_notice = ""
        if enabled != self._enabled:
            with self._epoch_lock:
                self._epoch += 1
            self._last_sample_at = None
            self._next_hotkey_attempt = 0.0
        self._enabled = enabled
        self._config = replace(self._config, enabled=enabled)
        self._policy.set_config(self._config)
        if not enabled:
            self._poll_event.clear()
            self._hide_all()
            self._backend.unregister_hotkey()
            self._hotkey_registered = False
        self._tick()

    def set_config(self, config: dict) -> None:
        self._config = replace(BlindModeConfig.from_dict(config), enabled=self._enabled)
        self._policy.set_config(self._config)
        # Recompute against a fresh sample; old masks must not survive a save.
        self._last_sample_at = None
        self._tick()

    def set_user_name_hint(self, name: Optional[str]) -> None:
        self._user_name_hint = name
        self._policy.set_user_name_hint(name)

    def _status(self, message: str) -> None:
        if message != self._last_status:
            self._last_status = message
            self.statusChanged.emit(message)

    def _hide_all(self) -> None:
        for surface in self._surfaces:
            surface.hide()

    def _emergency_off(self) -> None:
        if not self._enabled:
            return
        # Clearing visual obstruction cannot depend on disk or a callback.
        self.set_enabled(False)
        if self._dialog is not None:
            self._dialog.reject()
        try:
            saved = self._on_enabled_changed(False) if self._on_enabled_changed else False
        except Exception:
            log.exception("blind_emergency_save_failed")
            saved = False
        if saved is False:
            self._emergency_notice = "Off for this run — could not save the emergency stop. Turn Blind Ladder off in the app before restarting."
            self._status(self._emergency_notice)

    @QtCore.Slot(object, int)
    def _receive_sample(self, sample, epoch: int) -> None:
        if not self._started or not self._enabled or epoch != self._epoch:
            return
        ui, game, captured_at = sample
        if self._clock() - captured_at > _SAMPLE_MAX_AGE:
            return
        self._last_sample_at = captured_at
        self._policy.update(ui, game, captured_at)
        self._tick()

    def _tick(self) -> None:
        if not self._started:
            return
        if not self._enabled:
            self._hide_all()
            self._status(self._emergency_notice or "Off — normal SC2 display.")
            return
        if not self._backend.available:
            self._hide_all()
            self._status("Unavailable — native Blind Ladder requires Windows.")
            return
        if not self._hotkey_registered and self._clock() >= self._next_hotkey_attempt:
            self._hotkey_registered = self._backend.register_hotkey()
            self._next_hotkey_attempt = self._clock() + 1.0
        if not self._hotkey_registered:
            self._hide_all()
            self._poll_event.clear()
            self._status(f"Protection paused — {HOTKEY_LABEL} is used by another app. Free that shortcut to enable the emergency stop.")
            return
        if self._backend.poll_hotkey():
            self._emergency_off()
            return
        game_window = self._backend.find_game_window()
        if game_window is None or game_window.minimized or game_window.width <= 0 or game_window.height <= 0:
            self._poll_event.clear()
            self._hide_all()
            if self._last_hwnd is not None:
                self._invalidate_game()
            self._last_hwnd = None
            self._status("On — waiting for StarCraft II. Enable before queueing."
                         if self._config.coverage_verified else
                         "Setup needed — open SC2, then Set up coverage before queueing.")
            return
        if game_window.hwnd != self._last_hwnd:
            self._invalidate_game()
            self._last_hwnd = game_window.hwnd
        self._poll_event.set()
        if self._calibrating:
            return
        if not self._config.coverage_verified:
            self._hide_all()
            self._status("Setup needed — open Adjust coverage and check your loading, chat, and result areas before queueing.")
            return
        aspect = game_window.width / game_window.height
        calibrated = self._config.calibrated_aspect_ratio
        if calibrated is None or abs(aspect / calibrated - 1) > 0.01:
            self._hide_all()
            self._status("Coverage needs adjustment — SC2's aspect ratio changed. Open Adjust coverage before queueing.")
            return
        if not game_window.supported and not (
            game_window.display_mode == "fullscreen-unverified" and self._config.borderless_confirmed
        ):
            self._hide_all()
            self._status("Setup needed — use Windowed (Fullscreen) in SC2 and confirm it in Adjust coverage.")
            return
        if not game_window.foreground:
            self._hide_all()
            self._status("On — waiting for SC2 to return to the foreground.")
            return
        now = self._clock()
        if self._last_sample_at is None or now - self._last_sample_at > _SAMPLE_MAX_AGE:
            snapshot = self._policy.update(None, None, now)
        else:
            snapshot = self._policy.snapshot
        rects = (_FULL_RECT,) if snapshot.curtain else snapshot.masks
        if not self._render(game_window, rects, snapshot.curtain, snapshot.opponent_race):
            self._hide_all()
            self._status("Protection interrupted — Windows could not position the cover. Turn Blind Ladder off and on before queueing.")
            return
        self._status(snapshot.status + f" · {HOTKEY_LABEL} turns it off")

    def _invalidate_game(self) -> None:
        with self._epoch_lock:
            self._epoch += 1
        self._last_sample_at = None
        self._policy = BlindModePolicy(self._config, self._user_name_hint)

    def _render(self, game, rects, curtain=False, race=None) -> bool:
        signature = (game.hwnd, game.x, game.y, game.width, game.height, tuple(rects), curtain)
        changed = signature != self._render_signature
        target = 1 - self._active_bank if changed else self._active_bank
        surfaces = self._banks[target]
        while len(surfaces) < len(rects):
            surface = _Surface()
            surfaces.append(surface)
            self._surfaces.append(surface)
        # Double buffer entire layouts. Shrinking the live curtain before
        # showing every destination panel would briefly expose the score.
        for index, rect in enumerate(rects):
            surface = surfaces[index]
            surface.set_content(curtain, race if curtain else None)
            bounds = pixel_rect(rect, game)
            if not surface.isVisible():
                if not self._backend.position_overlay(int(surface.winId()), *bounds, show=False):
                    return False
                surface.show()
            if not self._backend.position_overlay(int(surface.winId()), *bounds):
                return False
        for surface in surfaces[len(rects):]:
            surface.hide()
        if changed:
            for surface in self._banks[self._active_bank]:
                surface.hide()
            self._active_bank = target
            self._render_signature = signature
        return True

    def _poll(self) -> None:
        session = self._session_factory()
        session.trust_env = False  # localhost must never use an HTTP proxy.
        try:
            while not self._stop_event.is_set():
                if not self._poll_event.wait(0.2):
                    continue
                if self._stop_event.is_set():
                    break
                with self._epoch_lock:
                    epoch = self._epoch
                ui = self._read_local(session, "ui")
                captured_at = self._clock()
                if "ScreenLoading" in (normalized_ui_screens(ui) or ()):
                    self._sampleReady.emit((ui, None, captured_at), epoch)
                game = self._read_local(session, "game") if ui is not None else None
                if not self._stop_event.is_set() and self._poll_event.is_set():
                    self._sampleReady.emit((ui, game, captured_at), epoch)
                self._stop_event.wait(_POLL_INTERVAL)
        except Exception:
            # No payloads or names in diagnostics. The UI watchdog handles loss
            # of samples independently of this worker's liveness.
            log.exception("blind_local_poller_stopped")
        finally:
            session.close()

    @staticmethod
    def _read_local(session, endpoint: str):
        try:
            with session.get(f"http://127.0.0.1:6119/{endpoint}",
                             timeout=(0.15, 0.25), allow_redirects=False, stream=True) as response:
                if response.status_code != 200:
                    return None
                content = bytearray()
                for chunk in response.iter_content(4096):
                    content.extend(chunk)
                    if len(content) > 65536:
                        return None
                import json
                value = json.loads(content)
                return value if isinstance(value, dict) else None
        except (requests.RequestException, ValueError, TypeError):
            return None

    def calibrate(self, parent=None) -> Optional[dict]:
        game = self._backend.find_game_window() if self._backend.available else None
        if game is None or game.minimized or game.width <= 0 or game.height <= 0:
            QtWidgets.QMessageBox.information(parent, "Set up Blind Ladder",
                "Open StarCraft II in Windowed or Windowed (Fullscreen), then choose Adjust coverage again. "
                "Set up coverage outside a live ladder game.")
            return None
        self._calibrating = True
        self._hide_all()
        dialog = _CoverageEditor(game, self._config, self._backend)
        self._dialog = dialog
        try:
            if not dialog.prepare_native():
                QtWidgets.QMessageBox.information(parent, "Coverage adjustment unavailable",
                    "Windows could not place the editor over StarCraft II. Check that SC2 is open in Windowed "
                    "or Windowed (Fullscreen), then try again.")
                return None
            return dialog.result_config() if dialog.exec() == QtWidgets.QDialog.Accepted else None
        finally:
            self._dialog = None
            dialog.deleteLater()
            self._calibrating = False
            self._tick()


class _CoverageEditor(QtWidgets.QDialog):
    """Draw/edit normalized mask bounds directly over the user's actual SC2."""
    _GROUPS = (("Before loading", "loading_masks"), ("In-game chat", "chat_masks"),
               ("Results", "score_masks"))

    def __init__(self, game, config, backend):
        super().__init__(None, QtCore.Qt.Tool | QtCore.Qt.FramelessWindowHint | QtCore.Qt.WindowStaysOnTopHint)
        self.setWindowTitle("Adjust Blind Ladder coverage")
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        self.setMouseTracking(True)
        self._game, self._config, self._backend = game, config, backend
        self._groups = {key: list(getattr(config, key)) for _, key in self._GROUPS}
        self._drag_start = None
        self._draft = None
        self.setGeometry(game.x, game.y, game.width, game.height)
        self._toolbar = QtWidgets.QFrame(self)
        self._toolbar.setObjectName("blindCoverageToolbar")
        self._toolbar.setStyleSheet("QFrame#blindCoverageToolbar { background: #11141b; border: 1px solid #7c8cff; border-radius: 10px; }")
        layout = QtWidgets.QVBoxLayout(self._toolbar)
        layout.setContentsMargins(16, 12, 16, 12)
        title = QtWidgets.QLabel("Adjust coverage on your SC2 window")
        title.setStyleSheet("font-size: 16px; font-weight: 600;")
        layout.addWidget(title)
        text = QtWidgets.QLabel("Select an area, then drag over the game to replace its cover. "
            "Cover every name, portrait, badge and rating before loading; include every line of chat. "
            "Loading itself uses a full cover. Leave SC2’s top-right opponent panel outside the chat cover.")
        text.setWordWrap(True)
        layout.addWidget(text)
        row = QtWidgets.QHBoxLayout()
        self._group = QtWidgets.QComboBox()
        for label, key in self._GROUPS:
            self._group.addItem(label, key)
        self._group.setAccessibleName("Coverage area")
        row.addWidget(self._group)
        self._region = QtWidgets.QComboBox()
        self._region.setAccessibleName("Cover rectangle")
        row.addWidget(self._region)
        add = QtWidgets.QPushButton("Add area")
        add.clicked.connect(self._add)
        row.addWidget(add)
        remove = QtWidgets.QPushButton("Remove area")
        remove.clicked.connect(self._remove)
        row.addWidget(remove)
        layout.addLayout(row)
        coordinates = QtWidgets.QHBoxLayout()
        self._spins = []
        for label in ("Left", "Top", "Width", "Height"):
            column = QtWidgets.QVBoxLayout()
            column.addWidget(QtWidgets.QLabel(label))
            spin = QtWidgets.QDoubleSpinBox()
            spin.setDecimals(1)
            spin.setRange(0 if label in ("Left", "Top") else 0.1, 100)
            spin.setSuffix(" %")
            spin.setAccessibleName(label + " percentage of SC2 window")
            spin.valueChanged.connect(self._coordinates_changed)
            self._spins.append(spin)
            column.addWidget(spin)
            coordinates.addLayout(column)
        layout.addLayout(coordinates)
        self._borderless = QtWidgets.QCheckBox("SC2 uses Windowed or Windowed (Fullscreen), and I can see this cover above the game.")
        self._borderless.setChecked(config.borderless_confirmed or game.supported)
        layout.addWidget(self._borderless)
        self._verified = QtWidgets.QCheckBox("I checked the loading cards, all chat lines, and result details on this layout.")
        self._verified.setChecked(config.coverage_verified)
        layout.addWidget(self._verified)
        note = QtWidgets.QLabel("Save unchecked to continue setup later. Protection starts after coverage is checked. "
                               "Escape cancels. The top-right opponent panel remains your deliberate reveal.")
        note.setWordWrap(True)
        note.setStyleSheet("color: #9aa3b2;")
        layout.addWidget(note)
        actions = QtWidgets.QHBoxLayout()
        move = QtWidgets.QPushButton("Move controls to bottom")
        self._controls_bottom = False
        def move_controls():
            self._controls_bottom = not self._controls_bottom
            move.setText("Move controls to top" if self._controls_bottom else "Move controls to bottom")
            self._place_toolbar()
        move.clicked.connect(move_controls)
        actions.addWidget(move)
        draw = QtWidgets.QPushButton("Draw mode")
        draw.clicked.connect(lambda: self._set_draw_mode(True))
        actions.addWidget(draw)
        actions.addStretch()
        buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Save | QtWidgets.QDialogButtonBox.Cancel)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        actions.addWidget(buttons)
        layout.addLayout(actions)
        self._draw_hint = QtWidgets.QFrame(self)
        self._draw_hint.setObjectName("blindDrawHint")
        self._draw_hint.setStyleSheet("QFrame#blindDrawHint { background: #11141b; border: 1px solid #7c8cff; border-radius: 8px; }")
        hint_layout = QtWidgets.QHBoxLayout(self._draw_hint)
        hint_layout.setContentsMargins(10, 6, 10, 6)
        hint_layout.addWidget(QtWidgets.QLabel("Drag to replace the selected area"))
        restore = QtWidgets.QPushButton("Show controls")
        restore.clicked.connect(lambda: self._set_draw_mode(False))
        hint_layout.addWidget(restore)
        self._draw_hint.hide()
        self._group.currentIndexChanged.connect(self._reload_regions)
        self._region.currentIndexChanged.connect(self._load_coordinates)
        self._reload_regions()

    def prepare_native(self) -> bool:
        """Prepare in physical pixels while still hidden, including mixed DPI."""
        return self._backend.position_editor(int(self.winId()), self._game.x, self._game.y,
                                             self._game.width, self._game.height)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if not self.prepare_native():
            QtCore.QTimer.singleShot(0, self.reject)
        self._place_toolbar()

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        if hasattr(self, "_toolbar"):
            self._place_toolbar()

    def _place_toolbar(self):
        width = min(740, max(300, self.width() - 32))
        self._toolbar.setFixedWidth(width)
        self._toolbar.adjustSize()
        y = max(8, self.height() - self._toolbar.height() - 12) if self._controls_bottom else 12
        self._toolbar.move(max(8, (self.width() - width) // 2), y)
        if hasattr(self, "_draw_hint"):
            self._draw_hint.adjustSize()
            self._draw_hint.move(max(8, (self.width() - self._draw_hint.width()) // 2), 8)

    def _set_draw_mode(self, drawing: bool) -> None:
        self._toolbar.setVisible(not drawing)
        self._draw_hint.setVisible(drawing)
        self._place_toolbar()

    def _reload_regions(self, *_):
        blocker = QtCore.QSignalBlocker(self._region)
        self._region.clear()
        for i in range(len(self._groups[self._group.currentData()])):
            self._region.addItem(f"Area {i + 1}")
        del blocker
        self._load_coordinates()

    def _load_coordinates(self, *_):
        regions = self._groups[self._group.currentData()]
        index = self._region.currentIndex()
        if index < 0:
            return
        rect = regions[index]
        for spin, value in zip(self._spins, (rect.x, rect.y, rect.width, rect.height)):
            blocker = QtCore.QSignalBlocker(spin)
            spin.setValue(value * 100)
            del blocker
        self.update()

    def _coordinates_changed(self, *_):
        if self._region.currentIndex() < 0:
            return
        x, y, width, height = [spin.value() / 100 for spin in self._spins]
        x, y = min(x, 0.999), min(y, 0.999)
        width, height = min(width, 1 - x), min(height, 1 - y)
        self._groups[self._group.currentData()][self._region.currentIndex()] = NormalizedRect(x, y, width, height)
        self._verified.setChecked(False)
        self._load_coordinates()

    def _add(self):
        areas = self._groups[self._group.currentData()]
        if len(areas) >= 8:
            return
        areas.append(NormalizedRect(0.25, 0.35, 0.3, 0.2))
        self._verified.setChecked(False)
        self._reload_regions()
        self._region.setCurrentIndex(len(areas) - 1)

    def _remove(self):
        areas = self._groups[self._group.currentData()]
        if len(areas) > 1:
            areas.pop(self._region.currentIndex())
            self._verified.setChecked(False)
            self._reload_regions()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == QtCore.Qt.LeftButton:
            self._drag_start = event.position()
            self._draft = None
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag_start is not None:
            self._draft = QtCore.QRectF(self._drag_start, event.position()).normalized().intersected(QtCore.QRectF(self.rect()))
            self.update()
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if self._draft is not None and self._draft.width() >= 8 and self._draft.height() >= 8:
            rect = self._draft
            self._groups[self._group.currentData()][self._region.currentIndex()] = NormalizedRect(
                rect.x() / self.width(), rect.y() / self.height(), rect.width() / self.width(), rect.height() / self.height())
            self._verified.setChecked(False)
            self._load_coordinates()
            self._set_draw_mode(False)
        self._draft = self._drag_start = None
        self.update()
        super().mouseReleaseEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QtGui.QPainter(self)
        painter.fillRect(self.rect(), QtGui.QColor(11, 13, 18, 110))
        for index, rect in enumerate(self._groups[self._group.currentData()]):
            bounds = QtCore.QRectF(rect.x * self.width(), rect.y * self.height(),
                                  rect.width * self.width(), rect.height * self.height())
            painter.fillRect(bounds, QtGui.QColor(11, 13, 18, 220))
            painter.setPen(QtGui.QPen(QtGui.QColor("#7c8cff"), 3 if index == self._region.currentIndex() else 1))
            painter.drawRect(bounds.adjusted(1, 1, -1, -1))
            painter.setPen(QtGui.QColor("#e6e8ee"))
            painter.drawText(bounds.adjusted(8, 8, -8, -8), QtCore.Qt.AlignTop | QtCore.Qt.AlignLeft, f"Area {index + 1}")
        if self._draft is not None:
            painter.setPen(QtGui.QPen(QtGui.QColor("#3ec0c7"), 2))
            painter.drawRect(self._draft)

    def _save(self):
        if self._verified.isChecked() and not self._borderless.isChecked():
            QtWidgets.QMessageBox.information(self, "Check SC2 display mode",
                "Choose Windowed or Windowed (Fullscreen) in SC2, then confirm that you can see the cover above the game.")
            return
        self.accept()

    def result_config(self) -> dict:
        return replace(self._config, **{key: tuple(value) for key, value in self._groups.items()},
                       loading_style="curtain", borderless_confirmed=self._borderless.isChecked(),
                       coverage_verified=self._verified.isChecked(),
                       calibrated_aspect_ratio=self._game.width / self._game.height).to_dict()
