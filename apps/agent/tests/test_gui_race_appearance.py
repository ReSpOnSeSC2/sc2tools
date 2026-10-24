from tests._gui_offscreen import run_gui_check


def test_race_choices_persist_without_changing_geometry_drafts_or_selected_opponent(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        from sc2tools_agent.ui.race_visuals import css_for_skin
        app.setStyleSheet(theme.STYLE)
        changes = []
        ui, win = make_window(window_page="companion", on_window_appearance=lambda skin, animations: changes.append((skin, animations)))
        win.show()
        win._set_window_size("Standard")
        app.processEvents()
        page = win._companion_page
        win._handle_input.setText("Unsaved player")
        initial_geometry = win.geometry()
        initial_context = page.console.context()
        assert page.current_appearance() == {"skin": "default", "animations": True}
        assert css_for_skin("default") == ""
        base_style = app.styleSheet()
        for skin in ("protoss", "terran", "zerg", "default"):
            page.appearance_skin.setCurrentIndex(page.appearance_skin.findData(skin))
            app.processEvents()
            assert ui._window_skin == skin
            assert changes[-1] == (skin, True)
            assert win.geometry() == initial_geometry
            assert page.console.context() == initial_context
            assert win._handle_input.text() == "Unsaved player"
            assert page.compact_card.property("raceSkin") == skin
            if skin == "default":
                assert app.styleSheet() == base_style
            else:
                assert css_for_skin(skin) in app.styleSheet()
        page.appearance_animations.setChecked(False)
        assert changes[-1] == ("default", False)
        assert not ui._window_animations
        for route in ("settings", "streams", "dashboard", "companion"):
            win._go_to_page(route)
            app.processEvents()
            assert win.geometry() == initial_geometry
            assert win._handle_input.text() == "Unsaved player"
            assert page.current_appearance() == {"skin": "default", "animations": False}
        assert not saved
        win._race_effects.shutdown()
        page.shutdown()
        win.hide()
    ''')


def test_failed_appearance_save_rolls_back_controls_and_does_not_apply_skin(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        app.setStyleSheet(theme.STYLE)
        attempts = []
        def fail(skin, animations):
            attempts.append((skin, animations))
            raise OSError("Unavailable settings file")
        ui, win = make_window(window_page="companion", window_skin="terran", window_animations=False, on_window_appearance=fail)
        page = win._companion_page
        assert page.current_appearance() == {"skin": "terran", "animations": False}
        previous_style = app.styleSheet()
        page.appearance_skin.setCurrentIndex(page.appearance_skin.findData("protoss"))
        assert attempts == [("protoss", False)]
        assert page.current_appearance() == {"skin": "terran", "animations": False}
        assert ui._window_skin == "terran" and not ui._window_animations
        assert app.styleSheet() == previous_style
        assert "Couldn't save appearance" in page.appearance_notice.text()
        win._race_effects.shutdown()
        page.shutdown()
        win.hide()
    ''')
