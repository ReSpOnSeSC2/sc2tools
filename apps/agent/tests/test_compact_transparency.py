from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP


def test_compact_main_and_pinned_opponent_are_text_only_with_real_alpha_in_every_skin(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
ui, window = make_window(window_page="companion", window_animations=False)
page = window._companion_page
page.timer.stop()
page.ghost_page.timer.stop()
window.show()
panel = page.overlays["opponent"]
panel.update_context({"name": "Nightshade", "race": "Terran", "mmr": 5757,
                      "headToHead": {"wins": 1, "losses": 3}})
from sc2tools_agent.ui.overlay_input import build_scouting_control
control = build_scouting_control(panel.identity_card.scouting_button, QtCore=QtCore, QtWidgets=QtWidgets)
for skin in ("default", "protoss", "terran", "zerg"):
    window._window_appearance_changed(skin, False)
    panel.hide()
    assert window._set_window_size("Compact")
    window.showNormal()
    app.processEvents()
    for target, effects in ((window, window._race_effects), (panel, panel._race_effects)):
        if target is panel:
            panel.show()
            page.inputTargetsChanged.emit()
            app.processEvents()
            assert not window.isVisible() and panel.isVisible()
        else:
            assert window.isVisible() and not panel.isVisible()
        assert target.testAttribute(QtCore.Qt.WA_TranslucentBackground)
        assert not effects.overlay.isVisible()
        image = target.grab().toImage()
        assert image.hasAlphaChannel()
        assert all(image.pixelColor(horizontal, vertical).alpha() == 0
                   for vertical in (0, image.height() - 1) for horizontal in range(image.width())), skin
        transparent = sum(image.pixelColor(horizontal, vertical).alpha() == 0
                          for vertical in range(image.height()) for horizontal in range(image.width()))
        assert transparent > image.width() * image.height() * 0.6, (skin, transparent)
        assert transparent < image.width() * image.height() * 0.98, "Text and scouting control must still render"
        assert image.save(str(base / (skin + "-" + ("main" if target is window else "pin") + ".png")))
    assert not page.compact_card.isVisible()
    assert [button for button in panel.identity_card.findChildren(QtWidgets.QToolButton) if button.isVisible()] == [panel.identity_card.scouting_button]
    control.sync()
    app.processEvents()
    button_image = control.grab().toImage()
    assert button_image.pixelColor(0, 0).alpha() == 0
    assert any(button_image.pixelColor(horizontal, vertical).alpha() > 0
               for vertical in range(button_image.height()) for horizontal in range(button_image.width()))
    assert control.icon().cacheKey() == panel.identity_card.scouting_button.icon().cacheKey()
    context = page._build_team_context_menu(panel.identity_card)
    actions = {action.text(): action for action in context.actions()}
    actions["Expand Companion"].trigger()
    app.processEvents()
    assert window.isVisible()
    assert window.size().toTuple() == (520, 480)
    assert window.property("textOverlay") is False
    assert window.grab().toImage().pixelColor(0, 0).alpha() == 255
    assert actions["Agent"].menu() is page.agent_menu_button.menu()
    context.deleteLater()
control.close()
page.shutdown()
window._race_effects.shutdown()
window.hide()
''', timeout=90)
