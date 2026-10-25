from __future__ import annotations

from dataclasses import replace
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.build_checkin.models import (
    BuildOptionModel, CheckinPrefs, LoadingCardModel, OpponentRowModel,
    PostgameCardModel, RandomizerStripModel, STATUS_SAVE_FAILED,
)
from sc2tools_agent.ui.companion_builds import build_companion_builds


class Controller:
    def __init__(self):
        self.available = True
        self.prefs = CheckinPrefs()
        self.calls = []

    def __getattr__(self, method):
        def record(*args, **kwargs):
            self.calls.append((method, args, kwargs))
        return record

    def actions(self, method):
        return [(args, kwargs) for name, args, kwargs in self.calls if name == method]


def option(key, name):
    return BuildOptionModel(key=key, name=name, source="catalog", group="yours", record="3–2", games=5, wins=3, losses=2)


BUILDS = (option("blink", "Blink expand"), option("stargate", "Stargate opening"))
OPPONENT_BUILDS = (option("bio", "Bio timing"), option("mech", "Mech expansion"))


def loading(**changes):
    return replace(LoadingCardModel(
        game_key="live-1", title="PvT · vs Opponent", matchup="PvT",
        waiting_for_matchup=False, featured=BUILDS,
        randomizer=RandomizerStripModel("Randomizer will roll", can_roll_now=True),
    ), **changes)


def postgame(**changes):
    return replace(PostgameCardModel(
        card_id="card-1", game_key="live-1", game_id="game-1",
        title="Victory · PvT · vs Opponent", matchup="PvT", featured=BUILDS,
        selection="blink", notes="Original note", can_add_build=True,
        opponent=OpponentRowModel(
            label="Opponent's build: Bio timing", name="Bio timing", selection="bio",
            server_key="bio", replay_key="bio", replay_name="Bio timing", featured=OPPONENT_BUILDS,
        ),
    ), **changes)


@pytest.fixture
def desk():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    controller = Controller()
    state = {"controller": controller}
    parent = QtWidgets.QWidget()
    widget = build_companion_builds(parent, controller_provider=lambda: state["controller"], QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    parent.resize(1000, 800)
    layout = QtWidgets.QVBoxLayout(parent)
    layout.addWidget(widget)
    parent.show()
    app.processEvents()
    yield widget, controller, state, app
    parent.close()
    parent.deleteLater()
    app.processEvents()


def test_selectors_are_embedded_and_unavailable_until_controller_connects(desk):
    widget, controller, state, app = desk
    assert not widget.isWindow()
    assert widget.tabs.tabText(0) == "Pre-game"
    assert widget.tabs.tabText(1) == "Post-game"
    state["controller"] = None
    widget.refresh()
    assert "Waiting" in widget.hint.text()
    assert not widget.loading_toggle.isEnabled()
    assert not widget.reopen.isEnabled()
    state["controller"] = controller
    controller.available = False
    widget.dispatch("bind_controller")
    assert "unavailable" in widget.hint.text()
    assert not widget.postgame_toggle.isEnabled()
    controller.available = True
    widget.refresh()
    assert widget.loading_toggle.isEnabled()


def test_loading_buttons_dispatch_once_to_the_same_game_and_retain_row_order(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_loading", (loading(),))
    widget.loading_builds.row("blink").click()
    assert controller.actions("declare") == [(("live-1", "blink"), {})]
    widget.roll_now.click()
    assert controller.actions("roll_now") == [(("live-1",), {})]
    widget.dispatch("update_loading", (loading(featured=tuple(reversed(BUILDS))),))
    assert widget.loading_builds.keys()[0] == ["blink", "stargate"]
    widget.dispatch("update_loading", (loading(collapsed=True, locked_label="Locked in: Blink expand", can_change=True),))
    widget.change_loading.click()
    widget.skip_loading.click()
    assert controller.actions("undeclare") == [(("live-1",), {})]
    assert controller.actions("not_now") == [(("live-1",), {})]


def test_loading_stale_updates_and_hides_never_target_a_new_game(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_loading", (loading(game_key="new-game"),))
    widget.dispatch("update_loading", (loading(status="Stale response"),))
    widget.dispatch("hide_loading", ("live-1", "new_game"))
    assert widget.loading_model.game_key == "new-game"
    assert "Stale" not in widget.loading_status.text()
    assert widget._loading_open
    widget.dispatch("hide_loading", ("new-game", "in_game"))
    widget._loading_action("declare", "blink")
    assert not controller.actions("declare")
    assert not widget._loading_open


def test_loading_saving_disables_selection_and_exposes_status(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_loading", (loading(saving=True, status="Saving your choice…"),))
    assert "Saving" in widget.loading_status.text()
    assert not widget.loading_builds.row("blink").isEnabled()
    widget._loading_action("declare", "blink")
    assert not controller.actions("declare")


def test_postgame_drafts_survive_updates_and_confirm_current_values(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(),))
    widget.postgame_builds.row("stargate").click()
    widget.notes.setPlainText("Pressure interrupted the plan")
    widget.dispatch("update_postgame", (postgame(notes="Old response", touched=True),))
    assert widget.selection() == "stargate"
    assert widget.notes.toPlainText() == "Pressure interrupted the plan"
    widget.confirm.click()
    assert controller.actions("confirm") == [(("card-1", "stargate", "Pressure interrupted the plan"), {})]
    assert controller.actions("update_draft")[-1] == (("card-1", "stargate", "Pressure interrupted the plan"), {})
    assert all(name != "declare" for name, args, kwargs in controller.calls)


def test_postgame_opponent_correction_and_replay_restore_use_shared_draft(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(),))
    widget.change_opponent.setChecked(True)
    widget.opponent_builds.row("mech").click()
    widget.dispatch("update_postgame", (postgame(),))
    assert widget.opponent_builds.selection() == "mech"
    assert "Mech expansion" in widget.opponent_label.text()
    widget.confirm.click()
    assert controller.actions("confirm")[-1] == (("card-1", "blink", "Original note", "mech"), {})
    widget.use_replay.click()
    widget.no_build.click()
    assert controller.actions("no_set_build")[-1] == (("card-1", "Original note", "bio"), {})


def test_stale_postgame_events_cannot_replace_or_act_on_new_card(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(card_id="new-card"),))
    widget.dispatch("update_postgame", (postgame(status="Stale save"),))
    widget.dispatch("hide_postgame", ("card-1", "confirmed"))
    assert widget.postgame_model.card_id == "new-card"
    assert widget._postgame_open
    widget.confirm.click()
    assert controller.actions("confirm")[-1][0][0] == "new-card"
    widget.dispatch("hide_postgame", ("new-card", "confirmed"))
    widget._confirm()
    assert len(controller.actions("confirm")) == 1
    assert "confirmed" in widget.postgame_status.text()


def test_busy_and_failed_save_states_preserve_retry_and_reopen(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(busy=True, status="Saving…"),))
    assert not widget.confirm.isEnabled()
    widget._confirm()
    widget._no_build()
    assert not controller.actions("confirm")
    assert not controller.actions("no_set_build")
    widget.dispatch("update_postgame", (postgame(status=STATUS_SAVE_FAILED),))
    assert widget.confirm.isEnabled()
    assert widget.postgame_status.text() == STATUS_SAVE_FAILED
    widget.notes.setPlainText("Return to this later")
    widget.later.click()
    assert controller.actions("later") == [(("card-1", "Return to this later"), {})]
    widget.dispatch("hide_postgame", ("card-1", "later"))
    widget.reopen.click()
    assert controller.actions("reopen") == [((), {})]
    widget.dispatch("show_postgame", (postgame(notes="Return to this later", touched=True),))
    assert widget.notes.toPlainText() == "Return to this later"


def test_notes_first_keeps_missing_planned_build_until_user_changes_it(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(variant="notes_first", selection="deleted-plan", prompt="You planned a custom opening. What happened?"),))
    assert widget.selection() == "deleted-plan"
    assert widget.confirm.text() == "Done"
    widget.confirm.click()
    assert controller.actions("confirm")[-1][0][1] == "deleted-plan"
    widget.change_own.click()
    widget.postgame_builds.row("stargate").click()
    widget.confirm.click()
    assert controller.actions("confirm")[-1][0][1] == "stargate"


def test_independent_preferences_stay_configurable_when_master_is_off(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_loading", (loading(),))
    widget.dispatch("show_postgame", (postgame(),))
    widget.set_assistance_enabled(False)
    assert "Assistance is off" in widget.hint.text()
    assert widget.loading_toggle.isEnabled()
    assert widget.postgame_toggle.isEnabled()
    widget.loading_toggle.setChecked(False)
    assert controller.actions("set_prefs") == [((), {"ask_at_loading": False})]
    widget._loading_action("declare", "blink")
    widget._confirm()
    widget._reopen()
    assert not controller.actions("declare")
    assert not controller.actions("confirm")
    assert not controller.actions("reopen")
    widget.set_assistance_enabled(True)
    assert widget.confirm.isEnabled()


def test_local_preset_gates_actions_but_never_changes_account_preferences(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_loading", (loading(),))
    widget.dispatch("show_postgame", (postgame(),))
    widget.set_feature_gates({"mode": "review", "preGameSelector": False, "postGameSelector": False})
    assert widget.loading_toggle.isEnabled() and widget.postgame_toggle.isEnabled()
    assert "Review preset hides" in widget.hint.text()
    assert not widget.confirm.isEnabled() and not widget.roll_now.isEnabled() and not widget.reopen.isEnabled()
    widget._loading_action("declare", "blink")
    widget._confirm()
    widget._reopen()
    assert not controller.calls
    widget.set_feature_gates({"mode": "practice", "preGameSelector": True, "postGameSelector": False})
    widget._loading_action("declare", "blink")
    assert controller.actions("declare") == [(("live-1", "blink"), {})]
    assert not controller.actions("set_prefs")
    assert not widget.confirm.isEnabled()


def test_reenabling_selector_restores_disabled_checkins_and_reports_save_failure(desk):
    widget, controller, state, app = desk
    old = CheckinPrefs(enabled=False, ask_at_loading=False, ask_after_game=True)
    widget.dispatch("update_prefs", (old,))
    widget.loading_toggle.setChecked(True)
    assert controller.actions("set_prefs")[-1] == ((), {"ask_at_loading": True, "enabled": True})
    widget.dispatch("update_prefs", (old,))
    assert "wasn't saved" in widget.hint.text()
    assert not widget.loading_toggle.isChecked()


def test_notes_obey_utf16_limit_and_new_card_does_not_reuse_prior_draft(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(notes_max=6),))
    widget.notes.setPlainText("🎮" * 4)
    assert widget.notes.toPlainText() == "🎮" * 3
    assert widget.note_count.text() == "6 / 6"
    widget.dispatch("show_postgame", (postgame(card_id="second", notes="New"),))
    assert widget.notes.toPlainText() == "New"
    assert widget.selection() == "blink"


def test_private_opponent_note_and_new_build_actions_use_same_card(desk):
    widget, controller, state, app = desk
    widget.dispatch("show_postgame", (postgame(opponent_pulse_id="1-S2-1-100"),))
    widget.opponent_note.editor.setPlainText("Watch the air transition")
    widget.opponent_note.save.click()
    assert controller.actions("update_opponent_note")[-1] == (("card-1", "Watch the air transition"), {})
    assert controller.actions("save_opponent_note")[-1] == (("card-1", "Watch the air transition"), {})
    widget.add_own_build.click()
    widget.add_opponent_build.click()
    assert controller.actions("add_build") == [(("card-1", "you"), {}), (("card-1", "opponent"), {})]
