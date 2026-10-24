from copy import deepcopy
import time

from PySide6 import QtCore, QtWidgets

from .test_companion_page import companion, game, wait_until


def team_snapshot(state, *, account="owner-one", key="team-game"):
    state["snapshot"].update(accountKey=account)
    state["snapshot"]["liveGame"] = {
        "phase": "match_in_progress", "gameKey": key, "isReplay": False,
        "capturedAt": time.time(), "displayTime": 60,
        "user": {"name": "Me", "race": "Protoss"},
        "players": [{"id": 1, "name": "Me", "race": "Protoss", "type": "user"},
                    {"id": 2, "name": "Ally", "race": "Terran", "type": "user"},
                    {"id": 3, "name": "Library one", "race": "Terran", "type": "user"},
                    {"id": 4, "name": "Library two", "race": "Zerg", "type": "user"}],
    }


def confirm(page):
    roster = page.team_roster_state
    keys = {row["name"]: row["key"] for row in roster.players}
    roster.confirm(keys["Me"], [keys["Library one"], keys["Library two"]])
    page._refresh_team_roster()
    return keys


def test_team_confirmation_preserves_compact_size_and_only_reveals_confirmed_enemy(companion):
    page, state, app = companion
    page.set_density("compact")
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    assert not page.team_roster_state.ready
    assert page.compact_card.identity["name"] == "—"
    assert page.compact_name.full_text == "Waiting for opponent"
    assert not page.mode_gates()["scoutingOverlay"]
    assert page.compact_card.contextMenuPolicy() == QtCore.Qt.CustomContextMenu
    before = page.minimumSize()
    keys = confirm(page)
    wait_until(app, lambda: bool(page._team_details.get("one")))
    assert page.compact_name.full_text == "Library one"
    assert page.minimumSize() == before
    assert not page.team_roster_widget.isVisible()
    assert page.mode_gates()["scoutingOverlay"]
    assert not page.mode_gates()["randomizer"]
    assert not page.mode_gates()["preGameSelector"]
    assert "unavailable in team games" in page.build_selectors.hint.text()
    randomizer_status = page.randomizer_page.status.text()
    assert "Team games have no native 1v1 widget-pick guidance" in randomizer_status
    assert "Pool settings remain available" in randomizer_status
    assert "overlay widget runs separately" in randomizer_status
    page._select_team_enemy(keys["Ally"])
    assert page.compact_name.full_text == "Library one"
    page._step_opponent(1)
    assert page.compact_name.full_text == "Library two"
    assert page.team_ghost_context()["ownKey"] == keys["Me"]
    assert page.team_ghost_context()["confirmed"] is True


def test_expanded_roster_click_selects_matching_history_and_keeps_every_enemy_accessible(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    keys = confirm(page)
    wait_until(app, lambda: set(page._team_details) == {"one", "two"})
    page.set_density("standard")
    page.show()
    app.processEvents()
    assert page.team_roster_summary.isVisible()
    page.team_roster_summary.open_roster.click()
    app.processEvents()
    assert len(page.team_roster_page._buttons) == 2
    target = next(button for button in page.team_roster_page._buttons if "Library two" in button.text())
    target.click()
    assert page.team_roster_state.selected_key == keys["Library two"]
    assert page._selected_id == "two"
    assert page._detail["name"] == "Library two"
    assert "not the current team rating" in page.team_roster_page.status.text()


def test_new_game_account_and_snapshot_failure_clear_team_history_and_selection(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    confirm(page)
    wait_until(app, lambda: bool(page._team_details))
    team_snapshot(state, key="next-team-game")
    page.refresh()
    wait_until(app, lambda: page.team_roster_state.candidate["gameKey"] == "next-team-game")
    assert not page.team_roster_state.ready
    assert not page._team_details
    confirm(page)
    wait_until(app, lambda: bool(page._team_details))
    team_snapshot(state, account="different-owner", key="next-team-game")
    page.refresh()
    wait_until(app, lambda: page._account_key == "different-owner")
    assert not page.team_roster_state.ready
    assert not page._team_details
    assert not page.team_ghost_context()
    state["snapshot_error"] = True
    page.refresh()
    wait_until(app, lambda: not page._snapshot_healthy)
    assert not page.team_roster_state.candidate
    assert not page.team_ghost_context()


def test_delayed_history_from_old_roster_or_identity_cannot_overwrite_selected_enemy(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    confirm(page)
    signature = deepcopy(page.team_roster_state.signature)
    page.team_roster_state.update({"paired": False})
    page._finish_team_history({"payload": {"pulseId": "one", "teamSignature": signature},
                               "result": {"name": "Stale enemy", "last5GamesScouting": [game()]}})
    assert "Stale enemy" not in repr(page._team_details)


def test_confirmation_dialog_chooses_roles_explicitly_and_rejects_a_changed_game(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    def choose_roles():
        dialog = app.activeModalWidget()
        for combo in dialog.findChildren(QtWidgets.QComboBox):
            if combo.accessibleName() == "Your live team player":
                assert combo.currentData() == page.team_roster_state.own_key
            else:
                combo.setCurrentIndex(combo.findData("ally" if combo.accessibleName() in {"Team role for Me", "Team role for Ally"} else "enemy"))
        dialog.findChild(QtWidgets.QDialogButtonBox).button(QtWidgets.QDialogButtonBox.Ok).click()
    QtCore.QTimer.singleShot(0, choose_roles)
    fallback = QtCore.QTimer(page)
    fallback.setSingleShot(True)
    fallback.timeout.connect(lambda: app.activeModalWidget().reject() if app.activeModalWidget() else None)
    fallback.start(1000)
    try:
        page._configure_teams()
    finally:
        fallback.stop()
    assert page.team_roster_state.ready
    def change_game():
        dialog = app.activeModalWidget()
        page._snapshot["liveGame"]["gameKey"] = "changed-during-dialog"
        page._refresh_team_roster()
        buttons = dialog.findChild(QtWidgets.QDialogButtonBox)
        buttons.button(QtWidgets.QDialogButtonBox.Ok).click()
        assert any("live game or roster changed" in item.text() for item in dialog.findChildren(QtWidgets.QLabel))
        buttons.button(QtWidgets.QDialogButtonBox.Cancel).click()
    QtCore.QTimer.singleShot(0, change_game)
    fallback.start(1000)
    try:
        page._configure_teams()
    finally:
        fallback.stop()
    assert not page.team_roster_state.ready


def test_historical_team_mmr_is_labeled_in_main_and_pinned_compact_cards_then_resets_for_1v1(companion):
    page, state, app = companion
    state["details"]["one"]["mmr"] = 4123
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    confirm(page)
    wait_until(app, lambda: page.compact_mmr.text() == "4123")
    assert page.compact_card.mmr_caption.text() == "1v1 MMR"
    assert "not team rating" in page.compact_mmr.toolTip()
    pinned = page.overlays["opponent"].identity_card
    assert pinned.mmr_caption.text() == "1v1 MMR"
    assert "not team rating" in pinned.mmr_label.toolTip()
    state["snapshot"]["liveGame"] = {"phase": "match_in_progress", "gameKey": "one-on-one", "isReplay": False,
                                        "capturedAt": time.time(), "opponent": {"name": "Single enemy", "race": "Zerg", "profile": {"mmr": 4500}}}
    page.refresh()
    wait_until(app, lambda: page.compact_mmr.text() == "4500")
    assert page.compact_card.mmr_caption.text() == "MMR"
    assert pinned.mmr_caption.text() == "MMR"


def test_same_roster_race_update_preserves_selected_enemy_but_name_change_resets_confirmation(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    keys = confirm(page)
    page._select_team_enemy(keys["Library two"])
    state["snapshot"]["liveGame"]["players"][3]["race"] = "Protoss"
    page.refresh()
    wait_until(app, lambda: page.team_roster_state.player(keys["Library two"])["race"] == "Protoss")
    assert page.team_roster_state.ready
    assert page.team_roster_state.selected_key == keys["Library two"]
    state["snapshot"]["liveGame"]["players"][3]["name"] = "Another enemy"
    page.refresh()
    wait_until(app, lambda: any(row["name"] == "Another enemy" for row in page.team_roster_state.players))
    assert not page.team_roster_state.ready


def test_compact_context_menu_exposes_previous_next_and_each_confirmed_enemy(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    keys = confirm(page)
    menu = page._build_team_context_menu(page.compact_card)
    labels = [action.text() for action in menu.actions()]
    next(action for action in menu.actions() if action.text() == "Next enemy").trigger()
    assert {"Previous enemy", "Next enemy", "Library one", "Library two", "Confirm teams…"} <= set(labels)
    assert page.team_roster_state.selected_key == keys["Library two"]


def test_rebinding_the_same_live_enemy_stops_the_previous_identity_readout(companion, monkeypatch):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    keys = confirm(page)
    wait_until(app, lambda: page._selected_id == "one" and bool(page._team_details.get("one")))
    stops = []
    monkeypatch.setattr(page.scouting_speech, "stop", lambda: stops.append(True))
    page._speech_game_key = "team-game:team:" + keys["Library one"]
    page.team_roster_state.bind(keys["Library one"], "two", state["items"])
    page._refresh_team_roster()
    assert page.team_roster_state.selected_key == keys["Library one"]
    assert page._selected_id == "two"
    assert stops
    assert page._speech_game_key is None
