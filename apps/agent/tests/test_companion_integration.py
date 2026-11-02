from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_companion_extends_the_existing_agent_and_preserves_navigation(tmp_path: Path):
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed")
    script = textwrap.dedent("""
        import sys
        from dataclasses import replace
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow
        from sc2tools_agent.build_checkin.models import LoadingCardModel
        from tests.test_build_checkin_ui_core import FakeWindow

        app = QtWidgets.QApplication([])
        base = Path(sys.argv[1])

        def handler(request):
            if request['action'] == 'snapshot':
                return {'paired': False, 'liveGame': None, 'live': None, 'preferences': {}}
            return {'items': [], 'preferences': {}}

        def window(paired, **preferences):
            ui = GuiUI(
                version='test', dashboard_url='https://example.test/app',
                pairing_url='https://example.test/devices', log_dir=base,
                log_file=base / 'agent.log', api_base='https://api.example.test',
                replay_folders=[], initial_paused=False, initial_paired=paired,
                initial_user_id='u1' if paired else None, initial_settings=SettingsPayload(),
                on_pause=lambda value: None, on_resync=lambda: None,
                on_choose_folder=lambda path: None, on_check_updates=lambda: None,
                on_save_settings=lambda value: None, on_quit=lambda: None,
                on_companion_action=handler,
                **preferences,
            )
            signals = _GuiSignals()
            win = _MainWindow(ui=ui, signals=signals, QtCore=QtCore,
                              QtGui=QtGui, QtWidgets=QtWidgets)
            return ui, signals, win

        paired_ui, paired_signals, paired = window(True)
        page_keys = ('dashboard', 'recent', 'log', 'settings', 'streams', 'companion', 'help')
        pages = tuple(paired._stack.widget(index) for index in range(7))
        parents = tuple(page.parentWidget() for page in pages)
        assert paired._stack.count() == 7 and paired._PAGE_KEYS == page_keys
        assert pages[5] is paired._companion_page and pages[6] is paired._help_page
        assert paired._stack.currentWidget() is paired._companion_page
        assert paired._nav_group.button(5).isChecked()
        paired._nav_group.button(3).click()
        assert paired._stack.currentIndex() == 3
        assert paired._obs_port_input is not None
        paired._on_paired('u1')
        assert paired._stack.currentIndex() == 3
        paired._nav_group.button(5).click()
        assert paired._stack.currentWidget() is paired._companion_page
        paired.show()
        paired.resize(1100, 800)
        app.processEvents()
        geometry = paired.geometry()
        paired._handle_input.setText('Unsaved companion navigation draft')
        paired._api_input.setText('https://draft.example.test')
        for index, key in enumerate(page_keys):
            paired._nav_group.button(index).click()
            app.processEvents()
            assert paired._PAGE_KEYS[paired._stack.currentIndex()] == key
            assert paired._stack.currentWidget() is pages[index]
            assert paired._nav_group.button(index).isChecked()
            assert paired._handle_input.text() == 'Unsaved companion navigation draft'
            assert paired._api_input.text() == 'https://draft.example.test'
            assert paired.geometry() == geometry
            assert all(paired._stack.widget(number) is page for number, page in enumerate(pages))
            assert all(page.parentWidget() is owner for page, owner in zip(pages, parents))
        paired._nav_group.button(5).click()
        assert paired._stack.currentWidget() is pages[5]
        paired.close()
        assert not paired.isVisible()
        assert not paired._really_quit

        unpaired_ui, unpaired_signals, unpaired = window(False)
        assert unpaired._stack.currentIndex() == 0
        unpaired._on_paired('new-user')
        assert unpaired._stack.currentWidget() is unpaired._companion_page
        assert unpaired._nav_group.button(5).isChecked()
        saved_ui, saved_signals, saved = window(True, window_page='settings')
        assert saved._stack.currentIndex() == 3
        saved._on_paired('u1')
        assert saved._stack.currentIndex() == 3
        restored_ui, restored_signals, restored = window(True, window_page='companion')
        assert restored._stack.currentWidget() is restored._companion_page
        pending_ui, pending_signals, pending = window(False, window_page='settings')
        pending._on_paired('new-user')
        assert pending._stack.currentIndex() == 3
        assert paired._nav_group.button(1).text() == 'Recent games'
        assert paired._checkin_host is not None
        paired._checkin_host._window_factory = lambda kind, owner: FakeWindow(kind)
        companion = paired._companion_page
        companion._paired = True
        companion._snapshot_healthy = True
        companion._preferences['overlaysEnabled'] = True
        companion._update_overlays()
        loading = LoadingCardModel(game_key='shared-current')
        paired._on_build_checkin('show_loading', (loading,))
        loading_window = paired._checkin_host.existing_window('loading')
        assert loading_window.visible
        assert companion.build_selectors.loading_model.game_key == 'shared-current'
        companion.set_preference('overlaysEnabled', False)
        assert not loading_window.visible
        assert not companion.ghost_page._assistance_enabled
        newer_loading = replace(loading, locked_label='Latest selection')
        paired._on_build_checkin('update_loading', (newer_loading,))
        assert not loading_window.visible
        companion.set_preference('overlaysEnabled', True)
        assert loading_window.visible
        assert loading_window.calls[-1] == ('show', newer_loading)
        assert companion.build_selectors.loading_model.locked_label == 'Latest selection'
        companion.set_preference('overlaysEnabled', False)
        paired._on_build_checkin('hide_loading', ('shared-current', 'ended'))
        companion.set_preference('overlaysEnabled', True)
        assert not loading_window.visible
        for win in (paired, unpaired, saved, restored, pending):
            win._companion_page.shutdown()
            win._log_timer.stop()
        app.processEvents()
        print('Companion agent integration passed')
    """)
    environment = {**os.environ, "QT_QPA_PLATFORM": "offscreen"}
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(Path(__file__).resolve().parents[1]), environment.get("PYTHONPATH")) if part
    )
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)], capture_output=True, text=True,
        timeout=45, env=environment,
    )
    assert result.returncode == 0, result.stdout + result.stderr
