import pytest

from sc2tools_agent.ui.window_sizes import (
    WINDOW_SIZE_PRESETS,
    fit_window_preset,
    normalize_information_layout,
    window_size_label,
)
from tests._gui_offscreen import run_gui_check


def test_four_named_layouts_have_distinct_information_levels():
    assert [(name, level) for name, level, _size in WINDOW_SIZE_PRESETS] == [
        ("Compact", "compact"), ("Standard", "standard"),
        ("Detailed", "detailed"), ("Full workspace", "full"),
    ]
    assert normalize_information_layout("compact") == "compact"
    assert normalize_information_layout("unknown") == "standard"
    assert normalize_information_layout(None) == "standard"


@pytest.mark.parametrize("name,expected", [
    ("Compact", (360, 190)), ("Standard", (1200, 900)), ("Detailed", (1440, 1080)),
])
def test_normal_sizes_use_logical_pixels_and_keep_the_existing_screen(name, expected):
    placement = fit_window_preset(name, (-2560, -200, 2560, 1440), position=(-100, 1000), frame=(16, 40))
    left, top, width, height = placement
    assert (width, height) == expected
    assert -2560 <= left and left + width + 16 <= 0
    assert -200 <= top and top + height + 40 <= 1240


def test_presets_clamp_to_small_work_areas_including_window_decorations():
    for name in ("Compact", "Standard", "Detailed"):
        assert fit_window_preset(name, (100, 30, 320, 200), position=(5000, -5000), frame=(8, 30)) == (100, 30, 312, 170)
    with pytest.raises(ValueError):
        fit_window_preset("Full workspace", (0, 0, 1920, 1080))


def test_labels_require_matching_geometry_and_density_and_allow_custom_manual_sizes():
    available = (0, 0, 1920, 1080)
    assert window_size_label((360, 190), available=available, layout="compact") == "Compact"
    assert window_size_label((400, 210), available=available, layout="compact") == "Custom"
    assert window_size_label((1200, 900), available=available, layout="full") == "Custom"
    assert window_size_label((1440, 1040), available=available, layout="detailed", frame=(16, 40)) == "Detailed"
    assert window_size_label((1920, 1080), available=available, layout="full", maximized=True) == "Full workspace"
    assert window_size_label((1920, 1080), available=available, layout="compact", maximized=True) == "Custom"


def test_real_window_presets_resize_change_density_and_restore_normal_chrome(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.window_sizes import fit_window_preset
        layouts = []
        ui, win = make_window(window_page="companion", on_window_information_layout=layouts.append)
        win.show()
        app.processEvents()
        page = win._companion_page
        assert page.current_density() == "standard"
        assert layouts == []
        for title, level in [("Compact", "compact"), ("Standard", "standard"), ("Detailed", "detailed"), ("Full workspace", "full")]:
            index = page.window_size.findData(title)
            page.window_size.setCurrentIndex(index)
            page.window_size.activated.emit(index)
            app.processEvents()
            QtTest.QTest.qWait(20)
            assert page.current_density() == level
            assert page.window_size.currentText() == title, (title, page.window_size.currentText(), win.size().toTuple())
            assert win._sidebar.isVisible() == (level != "compact")
            assert win.isMaximized() == (level == "full")
            if level != "full":
                screen = win.screen().availableGeometry()
                expected = fit_window_preset(title, screen.getRect(), frame=win._window_frame_size())
                assert (win.width(), win.height()) == expected[2:]
                assert screen.contains(win.frameGeometry()), (screen.getRect(), win.frameGeometry().getRect())
        assert layouts == ["compact", "standard", "detailed", "full"]
        page.windowSizeRequested.emit("compact")
        app.processEvents()
        assert (win.width(), win.height()) == (360, 190)
        assert not win._sidebar.isVisible()
        page.compact_enlarge.click()
        app.processEvents()
        assert win._sidebar.isVisible()
        assert page.current_density() == "standard"
        assert not win.isMaximized()
        page.shutdown()
    ''')


def test_manual_geometry_and_temporary_full_details_do_not_save_new_density(tmp_path):
    run_gui_check(tmp_path, '''
        layouts = []
        ui, win = make_window(window_page="companion", on_window_information_layout=layouts.append)
        win.show()
        app.processEvents()
        page = win._companion_page
        win._set_window_size("Compact")
        app.processEvents()
        win.resize(410, 220)
        app.processEvents()
        assert page.window_size.currentText() == "Custom"
        assert page.current_density() == "compact"
        assert layouts == ["compact"]
        page.set_density("full")
        app.processEvents()
        assert win._sidebar.isVisible()
        assert page.window_size.currentText() == "Custom"
        assert layouts == ["compact"]
        assert ui._window_information_layout == "compact"
        page.shutdown()
    ''')


def test_saved_compact_geometry_and_density_restore_without_new_preset_or_write(tmp_path):
    run_gui_check(tmp_path, '''
        layouts = []
        ui, win = make_window(window_page="companion", on_window_information_layout=layouts.append)
        win.show()
        app.processEvents()
        win._set_window_size("Compact")
        app.processEvents()
        geometry = bytes(win.saveGeometry().toBase64()).decode("ascii")
        ui2, restored = make_window(window_page="companion", window_geometry=geometry,
            window_information_layout="compact", on_window_information_layout=layouts.append)
        restored.show()
        app.processEvents()
        assert (restored.width(), restored.height()) == (360, 190)
        assert restored._companion_page.current_density() == "compact"
        assert not restored._sidebar.isVisible()
        assert layouts == ["compact"]
        assert restored._companion_page.window_size.currentText() == "Compact"
        ui3, forced = make_window(window_page="settings", window_geometry=geometry,
            window_information_layout="compact", on_window_information_layout=layouts.append)
        forced.show()
        app.processEvents()
        assert forced._stack.currentWidget() is forced._companion_page
        assert not forced._sidebar.isVisible()
        forced._go_to_page("settings")
        app.processEvents()
        assert forced._stack.currentIndex() == 3
        assert forced._sidebar.isVisible()
        assert forced._companion_page.current_density() == "standard"
        assert forced.width() >= min(820, forced.screen().availableGeometry().width() - forced._window_frame_size()[0])
        assert layouts == ["compact", "standard"]
        win._companion_page.shutdown()
        restored._companion_page.shutdown()
        forced._companion_page.shutdown()
    ''')


def test_failed_layout_save_leaves_geometry_and_information_unchanged(tmp_path):
    run_gui_check(tmp_path, '''
        def fail(level):
            raise OSError("disk unavailable")
        ui, win = make_window(window_page="companion", on_window_information_layout=fail)
        win.show()
        app.processEvents()
        page = win._companion_page
        before = win.geometry()
        page.window_size.setCurrentIndex(page.window_size.findData("Compact"))
        win._set_window_size("Compact")
        app.processEvents()
        assert win.geometry() == before
        assert page.current_density() == "standard"
        assert win._sidebar.isVisible()
        assert page.window_size_notice.isVisible()
        assert "Couldn't save" in page.window_size_notice.text()
        assert page.window_size.currentText() != "Compact"
        assert ui._window_information_layout == "standard"
        page.shutdown()
    ''')


def test_saved_maximized_workspace_restores_without_new_selection(tmp_path):
    run_gui_check(tmp_path, '''
        layouts = []
        ui, win = make_window(window_page="companion", on_window_information_layout=layouts.append)
        win.show()
        app.processEvents()
        win._set_window_size("Full workspace")
        app.processEvents()
        geometry = bytes(win.saveGeometry().toBase64()).decode("ascii")
        ui2, restored = make_window(window_page="companion", window_geometry=geometry,
            window_information_layout="full", on_window_information_layout=layouts.append)
        restored.show()
        app.processEvents()
        assert restored.isMaximized()
        assert restored._companion_page.current_density() == "full"
        assert restored._companion_page.window_size.currentText() == "Full workspace"
        assert layouts == ["full"]
        win._companion_page.shutdown()
        restored._companion_page.shutdown()
    ''')
