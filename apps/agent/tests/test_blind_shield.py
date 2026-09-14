"""Exercise real Qt shields against injected native/network boundaries.

QApplication lives in a subprocess: the suite's import-fallback tests remove
PySide modules. No desktop app, SC2 session or account is touched by these tests.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_native_shield_controller_and_coverage_editor(tmp_path: Path):
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed")
    script = textwrap.dedent('''
        import json
        import math
        import sys
        from dataclasses import replace
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent.blind_mode import BlindModeConfig, NormalizedRect
        from sc2tools_agent.ui.blind_windows import NativeGameWindow
        from sc2tools_agent.ui.blind_shield import (
            BlindShieldController, _CoverageEditor, _Surface, pixel_rect,
        )

        app = QtWidgets.QApplication([])
        now = [10.0]
        window = NativeGameWindow(77, -1920, 20, 1920, 1080, True, False, True)

        class Backend:
            available = True
            current = window
            hotkey_ok = True
            placement_ok = True
            hotkey = False
            def __init__(self):
                self.positioned = []
                self.registered = 0
                self.unregistered = 0
                self.closed = 0
            def find_game_window(self): return self.current
            def register_hotkey(self, hwnd=0):
                self.registered += 1
                return self.hotkey_ok
            def unregister_hotkey(self): self.unregistered += 1
            def poll_hotkey(self):
                result, self.hotkey = self.hotkey, False
                return result
            def consume_native_message(self, address): return False
            def position_overlay(self, hwnd, x, y, width, height, *, show=True):
                self.positioned.append((hwnd, x, y, width, height, show))
                # Emulate the physical -> Qt geometry delivery without native
                # calls. All test windows are offscreen at 100% scale.
                widget = QtWidgets.QWidget.find(hwnd)
                if widget is not None:
                    widget.setGeometry(x, y, width, height)
                return self.placement_ok
            def position_editor(self, *args): return self.placement_ok
            def close(self): self.closed += 1

        cfg = BlindModeConfig(enabled=True, coverage_verified=True,
                              calibrated_aspect_ratio=16/9, borderless_confirmed=True)
        backend = Backend()
        saved = []
        c = BlindShieldController(initial_enabled=True, config=cfg.to_dict(),
            user_name_hint="Local", backend=backend, clock=lambda: now[0],
            on_enabled_changed=lambda enabled: saved.append(enabled) or True)
        # Drive lifecycle on Qt thread without starting a real HTTP worker.
        c._started = True
        c._tick()
        assert c._hotkey_registered
        assert c._poll_event.is_set()
        assert all(x >= -1920 and x + w <= 0 for _, x, y, w, h, show in backend.positioned)
        assert any(not record[-1] for record in backend.positioned), "must position before showing"
        assert all(s.windowFlags() & QtCore.Qt.WindowTransparentForInput for s in c._surfaces)
        assert all(s.windowFlags() & QtCore.Qt.WindowDoesNotAcceptFocus for s in c._surfaces)

        loading = {"activeScreens": ["ScreenLoading"]}
        native = {"isReplay": False, "displayTime": 0, "players": [
            {"name":"Local", "type":"user", "race":"Protoss", "result":"Undecided"},
            {"name":"Never Render This Name", "type":"user", "race":"Random", "result":"Undecided"},
        ]}
        c._receive_sample((loading, native, now[0]), c._epoch)
        assert c._policy.snapshot.curtain
        active = [s for s in c._surfaces if s.isVisible()]
        assert len(active) == 1 and active[0].curtain and active[0].race == "Random"
        assert active[0].width() == 1920
        assert "Never Render" not in active[0].windowTitle()
        prior_curtain = active[0]
        bank = c._active_bank
        now[0] += .2
        c._receive_sample(({"activeScreens": []}, native, now[0]), c._epoch)
        now[0] += .2
        c._receive_sample(({"activeScreens": []}, native, now[0]), c._epoch)
        assert c._policy.snapshot.mode == "playing"
        assert c._active_bank != bank
        assert not prior_curtain.isVisible()
        assert all(not s.curtain for s in c._surfaces if s.isVisible())
        assert all(s.geometry().right() < -300 for s in c._surfaces if s.isVisible()), "chat must leave top-right panel free"

        backend.current = replace(window, foreground=False)
        c._tick()
        assert not any(s.isVisible() for s in c._surfaces)
        assert "foreground" in c._last_status
        backend.current = window
        c._tick()
        assert any(s.isVisible() for s in c._surfaces)

        backend.current = replace(window, width=1600)
        c._tick()
        assert not any(s.isVisible() for s in c._surfaces)
        assert "aspect ratio" in c._last_status
        backend.current = window

        c.set_config(replace(cfg, coverage_verified=False).to_dict())
        assert not any(s.isVisible() for s in c._surfaces)
        assert "Setup needed" in c._last_status
        c.set_config(cfg.to_dict())
        backend.current = replace(window, supported=False, display_mode="fullscreen-unverified")
        c.set_config(replace(cfg, borderless_confirmed=False).to_dict())
        assert not any(s.isVisible() for s in c._surfaces)
        assert "Windowed" in c._last_status
        backend.current = window
        c.set_config(cfg.to_dict())

        stale_epoch = c._epoch
        c.set_enabled(False)
        c._receive_sample((loading, native, now[0]), stale_epoch)
        assert not c._enabled and not c._poll_event.is_set()
        assert not any(s.isVisible() for s in c._surfaces)
        c.set_enabled(True)
        c._receive_sample((loading, native, now[0] - 5), c._epoch)
        assert c._policy.snapshot.opponent_race is None

        backend.hotkey = True
        c._tick()
        assert saved == [False] and not c._enabled
        assert not any(s.isVisible() for s in c._surfaces)
        c.set_enabled(True)
        c._on_enabled_changed = lambda value: False
        c._emergency_off()
        c._tick()
        assert not c._enabled and "Off for this run" in c._last_status

        c.set_enabled(True)
        backend.placement_ok = False
        c._tick()
        assert not any(s.isVisible() for s in c._surfaces)
        assert "interrupted" in c._last_status
        backend.placement_ok = True
        c.set_enabled(False)
        backend.hotkey_ok = False
        now[0] += 2
        c.set_enabled(True)
        assert "used by another app" in c._last_status
        assert not any(s.isVisible() for s in c._surfaces)
        before = backend.registered
        c._tick()
        assert backend.registered == before, "hotkey retry must back off"

        editor = _CoverageEditor(window, cfg, backend)
        assert editor.result_config()["coverage_verified"] is True
        editor._spins[0].setValue(99.9)
        assert editor.result_config()["coverage_verified"] is False
        rect = editor._groups["loading_masks"][0]
        assert rect.x + rect.width <= 1.00000001
        editor._group.setCurrentIndex(1)
        before = len(editor._groups["chat_masks"])
        editor._add()
        assert len(editor._groups["chat_masks"]) == before + 1
        editor._remove()
        editor._remove()
        assert len(editor._groups["chat_masks"]) == 1
        saved_config = BlindModeConfig.from_dict(editor.result_config())
        assert saved_config.calibrated_aspect_ratio == 16/9
        assert saved_config.loading_style == "curtain"
        editor.close()
        editor.deleteLater()

        # Fractional coordinates cover outward, including negative monitors.
        fractional = pixel_rect(NormalizedRect(.1001, .1001, .2001, .2001), window)
        assert fractional[0] == -1728
        assert fractional[2] == math.ceil(.3002 * 1920) - math.floor(.1001 * 1920)
        c.stop()
        assert backend.closed == 1
        assert not c._surfaces and not c._timer.isActive()
        app.processEvents()

        # HTTP is local, bounded, and does not follow redirects or proxy env.
        class Response:
            def __init__(self, status, chunks): self.status_code, self.chunks = status, chunks
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def iter_content(self, size): return iter(self.chunks)
        class Session:
            def __init__(self, response): self.response, self.calls = response, []
            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return self.response
        session = Session(Response(200, [b'{"activeScreens": []}']))
        assert BlindShieldController._read_local(session, "ui") == {"activeScreens": []}
        url, options = session.calls[0]
        assert url == "http://127.0.0.1:6119/ui" and options["allow_redirects"] is False
        assert BlindShieldController._read_local(Session(Response(302, [])), "ui") is None
        assert BlindShieldController._read_local(Session(Response(200, [b"x" * 65537])), "ui") is None
        assert BlindShieldController._read_local(Session(Response(200, [b'[]'])), "ui") is None
        assert BlindShieldController._read_local(Session(Response(200, [b'bad'])), "ui") is None
        print("native shield integration passed")
    ''')
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen", PYTHONDONTWRITEBYTECODE="1")
    env["PYTHONPATH"] = os.pathsep.join(filter(None, (str(Path(__file__).resolve().parents[1]), env.get("PYTHONPATH"))))
    result = subprocess.run([sys.executable, "-B", "-c", script, str(tmp_path)],
                            capture_output=True, text=True, timeout=40, env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "native shield integration passed" in result.stdout
