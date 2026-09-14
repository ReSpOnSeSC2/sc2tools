"""Visual QA for the real editor at desktop and high-DPI logical sizes."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_coverage_editor_fits_logical_sizes_and_keeps_background_translucent(tmp_path: Path) -> None:
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed")
    script = textwrap.dedent("""
        import json
        import os
        import sys
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtTest, QtWidgets
        from sc2tools_agent.blind_mode import BlindModeConfig
        from sc2tools_agent.ui.blind_windows import NativeGameWindow
        from sc2tools_agent.ui.blind_shield import _CoverageEditor
        from sc2tools_agent.ui.gui import _STYLE

        app = QtWidgets.QApplication([])
        for name in ('segoeui.ttf', 'segoeuib.ttf', 'seguisb.ttf', 'consola.ttf'):
            path = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / name
            if path.exists():
                QtGui.QFontDatabase.addApplicationFont(str(path))
        app.setStyleSheet(_STYLE)
        output = Path(os.environ.get('SC2TOOLS_BLIND_QA_DIR', sys.argv[1]))
        output.mkdir(parents=True, exist_ok=True)
        class Boundary:
            def position_editor(self, *args): return True
        observations = []
        problems = []
        def save_neutral(widget, name):
            image = widget.grab().toImage()
            neutral = QtGui.QImage(image.size(), QtGui.QImage.Format_ARGB32)
            neutral.fill(QtGui.QColor('#303640'))
            painter = QtGui.QPainter(neutral)
            painter.drawImage(0, 0, image)
            painter.end()
            neutral.save(str(output / name))
        for width, height, dpi in ((1920, 1080, 96), (1280, 720, 144), (640, 360, 288)):
            # Keep physical game metadata at 1920x1080, then resize to the
            # logical Qt dimensions a real DPI-aware native placement yields.
            game = NativeGameWindow(1, 0, 0, 1920, 1080, True, False, True, 'windowed', dpi)
            editor = _CoverageEditor(game, BlindModeConfig(), Boundary())
            editor.show()
            editor.resize(width, height)
            app.processEvents()
            toolbar = editor._toolbar
            image = editor.grab().toImage()
            alpha = image.pixelColor(0, 0).alpha()
            image.save(str(output / f'editor-{width}x{height}-alpha.png'))
            save_neutral(editor, f'editor-{width}x{height}.png')
            details = {
                'logical_size': [editor.width(), editor.height()], 'dpi': dpi,
                'toolbar': [toolbar.x(), toolbar.y(), toolbar.width(), toolbar.height()],
                'outside_alpha': alpha, 'checkboxes': [],
            }
            if not editor.rect().contains(toolbar.geometry()):
                problems.append(f'{width}x{height}: toolbar extends outside editor')
            if alpha != 110:
                problems.append(f'{width}x{height}: outside alpha {alpha}; expected 110')
            for control in (editor._borderless, editor._verified):
                details['checkboxes'].append({
                    'text': control.text(), 'width': control.width(),
                    'minimum_width': control.minimumSizeHint().width(),
                    'height': control.height(),
                })
                if control.minimumSizeHint().width() > control.width():
                    problems.append(f'{width}x{height}: checkbox text clipped: {control.text()}')
            move = next((button for button in editor.findChildren(QtWidgets.QPushButton)
                         if button.text().startswith('Move controls')), None)
            if move is not None:
                move.click()
                app.processEvents()
                details['toolbar_bottom'] = [toolbar.x(), toolbar.y(), toolbar.width(), toolbar.height()]
                if not editor.rect().contains(toolbar.geometry()):
                    problems.append(f'{width}x{height}: bottom toolbar extends outside editor')
            # At high DPI the full controls obscure most of the game. Draw
            # mode must actually clear that region and retain a usable exit.
            draw = next(button for button in editor.findChildren(QtWidgets.QPushButton)
                        if button.text() == 'Draw mode')
            restore = next(button for button in editor.findChildren(QtWidgets.QPushButton)
                           if button.text() == 'Show controls')
            draw.click()
            app.processEvents()
            hint = editor._draw_hint
            details['drawing_hint'] = [hint.x(), hint.y(), hint.width(), hint.height()]
            assert toolbar.isHidden() and hint.isVisible()
            assert editor.rect().contains(hint.geometry())
            assert height - hint.height() >= 64
            assert restore.width() >= restore.minimumSizeHint().width()
            save_neutral(editor, f'editor-{width}x{height}-draw.png')
            restore.click()
            app.processEvents()
            assert toolbar.isVisible() and hint.isHidden()
            draw.click()
            app.processEvents()
            start = QtCore.QPoint(width // 4, height // 4)
            end = QtCore.QPoint(width // 2, height * 3 // 5)
            assert editor.childAt(start) is None, 'The drag must start on the exposed game canvas'
            assert editor.childAt(end) is None, 'The drag must end on the exposed game canvas'
            before = editor._groups['loading_masks'][0]
            editor._verified.setChecked(True)
            QtTest.QTest.mousePress(editor, QtCore.Qt.LeftButton, pos=start)
            QtTest.QTest.mouseMove(editor, end)
            QtTest.QTest.mouseRelease(editor, QtCore.Qt.LeftButton, pos=end)
            app.processEvents()
            after = editor._groups['loading_masks'][0]
            assert after != before
            assert abs(after.x - start.x() / width) < .001
            assert abs(after.height - (end.y() - start.y()) / height) < .001
            assert not editor._verified.isChecked(), 'Changed coverage must be reverified'
            assert toolbar.isVisible() and hint.isHidden(), 'A completed drag restores controls'
            draw.click()
            QtTest.QTest.keyClick(editor, QtCore.Qt.Key_Escape)
            assert not editor.isVisible(), 'Escape must cancel even while controls are hidden'
            observations.append(details)
            editor.close()
            editor.deleteLater()
            app.processEvents()
        (output / 'editor-layout-report.json').write_text(
            json.dumps({'observations': observations, 'problems': problems}, indent=2), encoding='utf-8',
        )
        assert not problems, '\\n'.join(problems)
        print('editor layout and alpha checks passed')
    """)
    environment = dict(os.environ)
    environment["QT_QPA_PLATFORM"] = "offscreen"
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(Path(__file__).resolve().parents[1]), environment.get("PYTHONPATH")) if part
    )
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)],
                            capture_output=True, text=True, timeout=25, env=environment)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "editor layout and alpha checks passed" in result.stdout
