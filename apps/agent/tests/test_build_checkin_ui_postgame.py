"""The end-of-game card window (``ui/build_checkin_postgame.py``),
rendered offscreen from the controller's view models."""

from __future__ import annotations

import os
from dataclasses import replace
from typing import Any, Optional

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtTest, QtWidgets  # noqa: E402

from sc2tools_agent.build_checkin.models import (  # noqa: E402
    ADD_NEW_BUILD_HINT,
    CHECKING_REPLAY,
    NOT_NOW_CLEARS_TIP,
    NOTES_FIRST_HEADING,
    NOTES_MAX_LENGTH,
    STATUS_SAVE_FAILED,
    OpponentRowModel,
    PostgameCardModel,
)
from sc2tools_agent.ui.build_checkin_postgame import truncate_utf16, utf16_length  # noqa: E402
from sc2tools_agent.ui.build_checkin_window import (  # noqa: E402
    LOADING,
    POSTGAME,
    BuildCheckinHost,
)
from tests.test_build_checkin_ui_cards import (  # noqa: E402
    FEATURED,
    KEY,
    MORE,
    loading_model,
    option,
    postgame_model,
    show_loading,
    visible_texts,
)
from tests.test_build_checkin_ui_cards import app, harness, w32  # noqa: E402,F401 - pytest fixtures


# =================================================================== end card


def show_postgame(host: BuildCheckinHost, model: Optional[PostgameCardModel] = None):
    host.dispatch("show_postgame", (model or postgame_model(),))
    return host.window(POSTGAME)


def test_end_card_renders_result_reason_and_detected(harness) -> None:
    host, *_ = harness
    window = show_postgame(host)
    assert window.eyebrow.text() == "WHICH BUILD WERE YOU GOING FOR?"
    assert window.result.text() == "Victory · "
    assert window.result.property("tone") == "success"
    assert window.title.text() == "PvZ · vs Foo"
    assert window.detected.text() == "Replay classified as: PvZ - Macro Transition (Unclassified)"
    assert window.builds.selection() == "pvz-2-stargate-phoenix"
    selected = window.builds.row("pvz-2-stargate-phoenix")
    # The pre-selection explains itself; the roll is not repeated.
    assert selected.chips == [("Randomizer roll", "reason")]
    assert "Randomizer roll" in selected.accessibleName()
    assert window.builds.row("pvz-chargelot").chips == [
        ("Suggested", "suggested"), ("Usual", "usual"),
    ]
    text = visible_texts(window)
    for expected in ("Confirm", "No set build", "Later", "Turn off check-ins after games"):
        assert expected in text
    assert window.primary.isEnabled()
    assert window.notes.placeholderText() == "What threw the build off? (optional)"
    assert window.counter.text() == f"0 / {NOTES_MAX_LENGTH}"


def test_defeat_header_uses_the_danger_tone(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, postgame_model(
        title="Defeat · vs Foo", result="Defeat", result_tone="danger", matchup=None,
    ))
    assert window.result.property("tone") == "danger"
    assert window.title.text() == "vs Foo"


def test_checking_replay_state(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, postgame_model(
        status=CHECKING_REPLAY, featured=(), more=(), options_loading=True,
        detected_label=None, selection=None, reason=None, reason_label=None,
    ))
    assert window.status.text() == "Checking your replay…"
    assert window.status.property("tone") == "muted"
    assert window.loading.isVisibleTo(window)
    # Waiting is a line of text: an animated bar repainted the whole
    # see-through card about 180 times a second.
    assert window.findChildren(QtWidgets.QProgressBar) == []
    assert not window.primary.isEnabled()  # nothing selected yet
    host.dispatch("update_postgame", (postgame_model(status=STATUS_SAVE_FAILED),))
    assert window.status.property("tone") == "warning"


def test_random_game_without_matchup_explains_the_empty_list(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, postgame_model(
        featured=(), more=(), matchup=None, selection=None, status=CHECKING_REPLAY,
    ))
    assert window.empty.text() == "Your builds appear once the replay shows the matchup."
    assert window.empty.isVisibleTo(window)


def test_confirm_later_and_no_set_build_carry_the_notes(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    window.notes.setPlainText("Got scouted")
    window.primary.click()
    window.secondary.click()
    window.later.click()
    window.turn_off.click()
    assert controller.named("confirm") == [("checkin-1", "pvz-2-stargate-phoenix", "Got scouted")]
    assert controller.named("no_set_build") == [("checkin-1", "Got scouted")]
    assert controller.named("later") == [("checkin-1", "Got scouted")]
    assert controller.named("disable") == [("postgame",)]


def test_keyboard_shortcuts(harness, app) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    sequences = {
        shortcut.key().toString(): shortcut
        for shortcut in window.findChildren(QtGui.QShortcut)
    }
    assert {"Ctrl+Return", "Ctrl+Enter", "Esc"} <= set(sequences)
    sequences["Ctrl+Return"].activated.emit()
    sequences["Esc"].activated.emit()
    assert controller.named("confirm") == [("checkin-1", "pvz-2-stargate-phoenix", "")]
    assert controller.named("later") == [("checkin-1", "")]
    # Real key presses once the player clicked into the card.
    window.activateWindow()
    window.notes.setFocus()
    app.processEvents()
    if QtWidgets.QApplication.activeWindow() is window:
        QtTest.QTest.keyClick(window.notes, QtCore.Qt.Key_Return, QtCore.Qt.ControlModifier)
        QtTest.QTest.keyClick(window.notes, QtCore.Qt.Key_Escape)
        assert len(controller.named("confirm")) == 2
        assert len(controller.named("later")) == 2
        assert "\n" not in window.notes.toPlainText()


def test_picking_and_typing_update_the_draft(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    QtTest.QTest.mouseClick(window.builds.row("custom:dt-3-gate"), QtCore.Qt.LeftButton)
    assert window.builds.selection() == "custom:dt-3-gate"
    QtTest.QTest.keyClicks(window.notes, "ok")
    assert controller.named("update_draft") == [
        ("checkin-1", "custom:dt-3-gate", ""),
        ("checkin-1", "custom:dt-3-gate", "o"),
        ("checkin-1", "custom:dt-3-gate", "ok"),
    ]
    # Programmatic paints never count as the player's edits.
    controller.calls.clear()
    host.dispatch("update_postgame", (postgame_model(notes="from server"),))
    assert controller.named("update_draft") == []


def test_server_updates_never_override_a_touched_card(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, postgame_model(selection=None, reason=None, reason_label=None))
    QtTest.QTest.mouseClick(window.builds.row("custom:dt-3-gate"), QtCore.Qt.LeftButton)
    window.notes.setPlainText("my words")
    # The suggestion lands before the controller saw the click.
    host.dispatch("update_postgame", (postgame_model(
        selection="pvz-chargelot", reason="detected", reason_label="Detected in your replay",
        notes="",
    ),))
    assert window.builds.selection() == "custom:dt-3-gate"
    assert window.notes.toPlainText() == "my words"
    # Untouched cards follow the model.
    other = show_postgame(host, postgame_model(card_id="checkin-2", selection=None))
    host.dispatch("update_postgame", (postgame_model(card_id="checkin-2", selection="pvz-chargelot"),))
    assert other.builds.selection() == "pvz-chargelot"


def test_reshown_draft_restores_selection_and_notes(harness) -> None:
    host, *_ = harness
    window = show_postgame(host)
    host.dispatch("hide_postgame", ("checkin-1", "preempted"))
    show_postgame(host, postgame_model(selection="custom:dt-3-gate", notes="kept", touched=True))
    assert window.builds.selection() == "custom:dt-3-gate"
    assert window.notes.toPlainText() == "kept"


def test_notes_counter_and_limit(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    window.notes.setPlainText("x" * 905)
    assert window.counter.text() == f"905 / {NOTES_MAX_LENGTH}"
    assert window.counter.property("tone") == "warning"
    window.notes.setPlainText("y" * 1500)
    assert len(window.notes.toPlainText()) == NOTES_MAX_LENGTH
    assert window.counter.text() == f"{NOTES_MAX_LENGTH} / {NOTES_MAX_LENGTH}"
    assert window.counter.property("tone") == "danger"
    assert controller.named("update_draft")[-1][2] == "y" * NOTES_MAX_LENGTH
    window.primary.click()
    assert len(controller.named("confirm")[0][2]) == NOTES_MAX_LENGTH


def test_search_filters_rows_without_reordering(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    QtTest.QTest.keyClicks(window.builds.search, "build 3")
    assert window.builds.visible_keys() == ["catalog-3"]
    assert window.builds.more_area.isVisibleTo(window)
    QtTest.QTest.keyClicks(window.builds.search, "zzz")
    assert window.builds.visible_keys() == []
    assert window.builds.empty_label.text() == "No builds match your search."
    window.builds.search.clear()
    window.builds.set_filter("")
    assert window.builds.visible_keys() == [o.key for o in FEATURED]
    assert window.builds.keys() == ([o.key for o in FEATURED], [o.key for o in MORE])
    assert controller.named("interacted") == [("checkin-1",)]  # throttled


def test_preselected_row_in_more_builds_is_revealed(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, postgame_model(selection="catalog-6", reason="usual", reason_label="Your usual build"))
    assert window.builds.is_expanded()
    assert window.builds.row("catalog-6").chips == [("Your usual build", "reason")]


def test_busy_card_disables_its_controls(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, postgame_model(busy=True))
    assert window.primary.text() == "Saving…"
    assert not window.primary.isEnabled()
    assert not window.secondary.isEnabled() and not window.later.isEnabled()
    assert not window.builds.row("custom:dt-3-gate").isEnabled()
    assert window.notes.isReadOnly()
    for shortcut in window.findChildren(QtGui.QShortcut):
        shortcut.activated.emit()
    assert controller.named("confirm") == []
    assert controller.named("later") == []


def test_notes_first_variant(harness) -> None:
    host, controller, *_ = harness
    prompt = "You planned DT into 3 Gate · replay looked like Macro. What happened?"
    window = show_postgame(host, postgame_model(
        variant="notes_first", heading=NOTES_FIRST_HEADING, prompt=prompt,
        selection="custom:dt-3-gate", reason=None, reason_label=None,
        planned_name="DT into 3 Gate", detected_name="Macro",
    ))
    assert window.eyebrow.text() == "WHAT HAPPENED?"
    assert window.prompt.text() == prompt
    assert not window.picker.isVisibleTo(window)
    assert not window.detected.isVisibleTo(window)
    assert window.primary.text() == "Done"
    assert window.secondary.text() == "Change build"
    assert not window.later.isVisibleTo(window)
    window.notes.setPlainText("Forgot the forge")
    window.primary.click()
    assert controller.named("confirm") == [("checkin-1", "custom:dt-3-gate", "Forgot the forge")]

    window.secondary.click()
    assert window.picker.isVisibleTo(window)
    assert window.primary.text() == "Confirm"
    assert not window.secondary.isVisibleTo(window)
    QtTest.QTest.mouseClick(window.builds.row("pvz-chargelot"), QtCore.Qt.LeftButton)
    window.primary.click()
    assert controller.named("confirm")[-1] == ("checkin-1", "pvz-chargelot", "Forgot the forge")


def test_notes_first_keeps_a_planned_build_missing_from_the_options(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, postgame_model(
        variant="notes_first", prompt="You planned Old build · …", selection="custom:deleted",
        reason=None, reason_label=None,
    ))
    assert window.builds.selection() is None
    assert window.primary.isEnabled()
    window.primary.click()
    assert controller.named("confirm") == [("checkin-1", "custom:deleted", "")]


def test_intro_line_on_the_end_card(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, postgame_model(show_intro=True))
    assert window.intro.isVisibleTo(window)
    window.intro_dismiss.click()
    assert controller.named("dismiss_intro") == [()]
    host.dispatch("update_postgame", (postgame_model(show_intro=False),))
    assert not window.intro.isVisibleTo(window)


def test_hide_only_hides_the_matching_card(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    host.dispatch("hide_postgame", ("checkin-0", "replaced"))
    assert window.isVisible()
    host.dispatch("hide_postgame", ("checkin-1", "confirmed"))
    assert not window.isVisible()
    for shortcut in window.findChildren(QtGui.QShortcut):
        shortcut.activated.emit()
    assert controller.named("confirm") == [] and controller.named("later") == []


def test_notes_limit_counts_like_the_api(harness) -> None:
    # The API (JavaScript) counts UTF-16 units: an emoji is two.
    host, controller, *_ = harness
    window = show_postgame(host)
    window.notes.setPlainText("🎲" * 600)
    text = window.notes.toPlainText()
    assert text == "🎲" * 500
    assert window.counter.text() == f"{NOTES_MAX_LENGTH} / {NOTES_MAX_LENGTH}"
    window.notes.setPlainText("a" + "🎲" * 500)
    assert window.notes.toPlainText() == "a" + "🎲" * 499  # never half a character
    assert utf16_length(controller.named("update_draft")[-1][2]) <= NOTES_MAX_LENGTH


def test_utf16_helpers() -> None:
    assert utf16_length("abc") == 3
    assert utf16_length("a🎲") == 3
    assert truncate_utf16("ab🎲c", 3) == "ab"
    assert truncate_utf16("ab🎲c", 4) == "ab🎲"
    assert truncate_utf16("short", 10) == "short"


# ========================================================== re-picking


def test_changing_marks_the_standing_pick_and_explains_not_now(harness) -> None:
    host, controller, *_ = harness
    window = show_loading(host, loading_model(
        changing=True, locked_key="custom:dt-3-gate",
        locked_label="Locked in: DT into 3 Gate", randomizer=None,
        not_now_tip=NOT_NOW_CLEARS_TIP,
    ))
    assert window.full.isVisibleTo(window) and not window.bar.isVisibleTo(window)
    assert window.builds.row("custom:dt-3-gate").chips == [("Current pick", "reason")]
    assert "Current pick" in window.builds.row("custom:dt-3-gate").accessibleName()
    assert window.not_now.toolTip() == NOT_NOW_CLEARS_TIP
    assert not window.strip.isVisibleTo(window)
    QtTest.QTest.mouseClick(window.builds.row("pvz-chargelot"), QtCore.Qt.LeftButton)
    assert controller.named("declare") == [(KEY, "pvz-chargelot")]
    host.dispatch("update_loading", (loading_model(),))
    assert window.builds.row("custom:dt-3-gate").chips == []
    assert window.not_now.toolTip() == "Skip this game's check-in at loading"


# ===================================================== opponent's build

OPP_FEATURED = (
    option("zerg-12-pool", "Zerg - 12 Pool", 2, 1),
    option("custom:ling-flood", "Ling flood"),
)
OPP_MORE = (
    option("zvp-roach-rush", "ZvP - Roach Rush", group="catalog"),
    option("zvp-ling-bane-bust", "ZvP - Ling Bane Bust", group="catalog"),
)


def opp_model(**changes: Any) -> OpponentRowModel:
    base = OpponentRowModel(
        label="Opponent's build: Zerg - 12 Pool", name="Zerg - 12 Pool",
        selection="zerg-12-pool", server_key="zerg-12-pool",
        replay_key="zerg-12-pool", replay_name="Zerg - 12 Pool",
        featured=OPP_FEATURED, more=OPP_MORE,
    )
    return replace(base, **changes)


def with_opponent(**changes: Any) -> PostgameCardModel:
    opponent = changes.pop("opponent", None) or opp_model()
    return postgame_model(
        game_id="g-1", opponent=opponent, can_add_build=True,
        add_build_hint=ADD_NEW_BUILD_HINT, **changes,
    )


def test_end_card_before_the_replay_has_no_opponent_row(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host)
    assert not window.opp_row.isVisibleTo(window)
    assert not window.opp_picker.isVisibleTo(window)
    assert window.add_build.isVisibleTo(window)
    assert window.add_build.text() == "Add new build…"
    assert not window.add_build.isEnabled()
    assert window.add_build.toolTip() == "Available once your replay uploads"
    assert window.add_build.accessibleDescription() == "Available once your replay uploads"
    window.add_build.click()
    assert controller.named("add_build") == []


def test_opponent_row_is_a_compact_accordion(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent())
    assert window.opp_row.isVisibleTo(window)
    assert window.opp_label.text() == "Opponent's build: Zerg - 12 Pool"
    assert window.opp_label.textFormat() == QtCore.Qt.PlainText
    assert not window.opp_changed.isVisibleTo(window)
    assert window.opp_change.text() == "Change"
    assert not window.opp_picker.isVisibleTo(window)
    assert window.picker.isVisibleTo(window)
    closed_height = window.height()

    window.opp_change.click()
    assert window.opp_picker.isVisibleTo(window)
    assert not window.picker.isVisibleTo(window)  # swapped, not stacked
    assert window.opp_change.text() == "Close"
    assert window.opp_builds.featured_label.text() == "FACED BEFORE"
    assert window.opp_builds.search.placeholderText() == "Search opponent builds"
    assert window.opp_builds.more_toggle.text() == "All builds…  (2)"
    assert window.opp_builds.selection() == "zerg-12-pool"
    assert window.opp_builds.keys() == (
        [o.key for o in OPP_FEATURED], [o.key for o in OPP_MORE],
    )
    assert window.card.width() == window.WIDTH
    assert window.height() < closed_height + 4 * 32  # still a compact card
    assert controller.named("interacted") == [("checkin-1",)]

    window.opp_change.click()
    assert not window.opp_picker.isVisibleTo(window)
    assert window.picker.isVisibleTo(window)


def test_all_builds_title_shows_without_faced_before_rows(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent(opponent=opp_model(featured=())))
    window.opp_change.click()
    assert window.opp_builds.more_label.text() == "ALL BUILDS"
    assert window.opp_builds.more_label.isVisibleTo(window)


def test_picking_an_opponent_build_collapses_and_marks_it_changed(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent())
    window.notes.setPlainText("Roaches at 4:00")
    controller.calls.clear()
    window.opp_change.click()
    window.opp_builds.more_toggle.click()
    QtTest.QTest.mouseClick(window.opp_builds.row("zvp-roach-rush"), QtCore.Qt.LeftButton)
    assert not window.opp_picker.isVisibleTo(window)
    assert window.picker.isVisibleTo(window)
    assert window.opp_label.text() == "Opponent's build: ZvP - Roach Rush"
    assert window.opp_changed.isVisibleTo(window)
    assert window.opp_changed.text() == "· changed"
    assert window.opp_label.toolTip() == "Replay classified as: Zerg - 12 Pool"
    assert window.opp_label.accessibleName() == "Opponent's build: ZvP - Roach Rush, changed"
    assert controller.named("update_draft") == [
        ("checkin-1", "pvz-2-stargate-phoenix", "Roaches at 4:00", "zvp-roach-rush"),
    ]
    window.primary.click()
    window.secondary.click()
    assert controller.named("confirm") == [
        ("checkin-1", "pvz-2-stargate-phoenix", "Roaches at 4:00", "zvp-roach-rush"),
    ]
    assert controller.named("no_set_build") == [
        ("checkin-1", "Roaches at 4:00", "zvp-roach-rush"),
    ]


def test_picking_the_servers_build_again_is_not_a_change(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent())
    window.opp_change.click()
    QtTest.QTest.mouseClick(window.opp_builds.row("zerg-12-pool"), QtCore.Qt.LeftButton)
    assert window.opp_label.text() == "Opponent's build: Zerg - 12 Pool"
    assert not window.opp_changed.isVisibleTo(window)
    assert window.opp_label.toolTip() == ""


def test_actions_leave_the_opponent_out_until_it_is_touched(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent())
    QtTest.QTest.mouseClick(window.builds.row("custom:dt-3-gate"), QtCore.Qt.LeftButton)
    window.primary.click()
    assert controller.named("update_draft") == [("checkin-1", "custom:dt-3-gate", "")]
    assert controller.named("confirm") == [("checkin-1", "custom:dt-3-gate", "")]


def test_use_replays_label_restores_the_classifier_pick(harness) -> None:
    host, controller, *_ = harness
    corrected = opp_model(
        label="Opponent's build: ZvP - Roach Rush", name="ZvP - Roach Rush",
        selection="zvp-roach-rush", server_key="zvp-roach-rush", corrected=True,
        detected_label="Replay classified as: Zerg - 12 Pool", show_use_replay=True,
    )
    window = show_postgame(host, with_opponent(opponent=corrected))
    assert window.opp_label.toolTip() == "Replay classified as: Zerg - 12 Pool"
    window.opp_change.click()
    assert window.opp_use_replay.isVisibleTo(window)
    assert window.opp_use_replay.text() == "Use replay's label"
    window.opp_use_replay.click()
    assert window.opp_builds.selection() == "zerg-12-pool"
    assert not window.opp_picker.isVisibleTo(window)
    assert window.opp_label.text() == "Opponent's build: Zerg - 12 Pool"
    assert window.opp_changed.isVisibleTo(window)
    assert window.opp_label.toolTip() == ""
    assert controller.named("update_draft")[-1][3] == "zerg-12-pool"
    window.opp_change.click()
    assert not window.opp_use_replay.isVisibleTo(window)


def test_use_replays_label_that_is_not_an_option_sends_none(harness) -> None:
    host, controller, *_ = harness
    corrected = opp_model(
        label="Opponent's build: ZvP - Roach Rush", name="ZvP - Roach Rush",
        selection="zvp-roach-rush", server_key="zvp-roach-rush", corrected=True,
        replay_key=None, replay_name="Zerg Standard Play (Unclassified)",
        show_use_replay=True,
    )
    window = show_postgame(host, with_opponent(opponent=corrected))
    window.opp_change.click()
    window.opp_use_replay.click()
    assert window.opp_builds.selection() is None
    assert window.opp_label.text() == "Opponent's build: Zerg Standard Play (Unclassified)"
    assert window.opp_changed.isVisibleTo(window)
    assert controller.named("update_draft")[-1][3] is None
    window.primary.click()
    assert controller.named("confirm")[-1][3] is None


def test_escape_closes_the_opponent_list_before_meaning_later(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent())
    escape = next(
        shortcut for shortcut in window.findChildren(QtGui.QShortcut)
        if shortcut.key().toString() == "Esc"
    )
    window.opp_change.click()
    escape.activated.emit()
    assert not window.opp_picker.isVisibleTo(window)
    assert controller.named("later") == []
    escape.activated.emit()
    assert controller.named("later") == [("checkin-1", "")]


def test_add_new_build_under_each_list(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent())
    assert window.add_build.isEnabled()
    assert window.add_build.toolTip() == ADD_NEW_BUILD_HINT
    window.add_build.click()
    window.opp_change.click()
    assert window.opp_add.isVisibleTo(window) and window.opp_add.isEnabled()
    assert window.opp_add.text() == "Add new build…"
    window.opp_add.click()
    assert controller.named("add_build") == [("checkin-1", "you"), ("checkin-1", "opponent")]


def test_busy_card_disables_the_opponent_row_and_links(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent(busy=True))
    for widget in (window.add_build, window.opp_change, window.opp_add, window.opp_use_replay):
        assert not widget.isEnabled()
    window.opp_change.click()
    assert not window.opp_picker.isVisibleTo(window)
    assert controller.named("add_build") == []


def test_untouched_opponent_row_follows_the_server(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent())
    host.dispatch("update_postgame", (with_opponent(opponent=opp_model(
        label="Opponent's build: Ling flood", name="Ling flood",
        selection="custom:ling-flood", server_key="custom:ling-flood", corrected=True,
    )),))
    assert window.opp_label.text() == "Opponent's build: Ling flood"
    assert window.opp_builds.selection() == "custom:ling-flood"


def test_touched_opponent_row_keeps_its_pick_through_updates(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent())
    window.opp_change.click()
    QtTest.QTest.mouseClick(window.opp_builds.row("custom:ling-flood"), QtCore.Qt.LeftButton)
    host.dispatch("update_postgame", (with_opponent(opponent=opp_model(
        label="Opponent's build: ZvP - Roach Rush", selection="zvp-roach-rush",
        server_key="zvp-roach-rush", corrected=True,
    )),))
    assert window.opp_builds.selection() == "custom:ling-flood"
    assert window.opp_label.text() == "Opponent's build: Ling flood"
    assert window.opp_changed.isVisibleTo(window)


def test_reshown_card_restores_the_opponent_draft(harness) -> None:
    host, controller, *_ = harness
    window = show_postgame(host, with_opponent())
    host.dispatch("hide_postgame", ("checkin-1", "preempted"))
    show_postgame(host, with_opponent(touched=True, opponent=opp_model(
        label="Opponent's build: ZvP - Roach Rush", name="ZvP - Roach Rush",
        selection="zvp-roach-rush", changed=True, touched=True,
    )))
    assert window.opp_builds.selection() == "zvp-roach-rush"
    assert window.opp_changed.isVisibleTo(window)
    window.primary.click()
    assert controller.named("confirm")[-1][3] == "zvp-roach-rush"


def test_a_new_card_forgets_the_previous_opponent_list(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent())
    window.opp_change.click()
    show_postgame(host, with_opponent(card_id="checkin-2", opponent=opp_model(
        featured=(option("protoss-dt-rush", "Protoss - DT Rush"),), more=(),
        selection=None, server_key=None, replay_key=None,
    )))
    assert window.opp_builds.keys() == (["protoss-dt-rush"], [])
    assert not window.opp_picker.isVisibleTo(window)


def test_opponent_strings_are_plain_text(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent(opponent=opp_model(
        label="Opponent's build: <b>Proxy</b>", name="<b>Proxy</b>",
    )))
    assert window.opp_label.text() == "Opponent's build: <b>Proxy</b>"
    for label in window.findChildren(QtWidgets.QLabel):
        assert label.textFormat() == QtCore.Qt.PlainText, label.objectName()


def test_notes_first_change_build_closes_the_opponent_list(harness) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent(
        variant="notes_first", heading=NOTES_FIRST_HEADING, prompt="You planned X",
        selection="custom:dt-3-gate", reason=None, reason_label=None,
    ))
    assert window.opp_row.isVisibleTo(window)
    assert not window.picker.isVisibleTo(window)
    window.opp_change.click()
    assert window.opp_picker.isVisibleTo(window)
    window.secondary.click()  # Change build
    assert window.picker.isVisibleTo(window)
    assert not window.opp_picker.isVisibleTo(window)


def test_opening_the_web_keeps_the_browser_in_front(harness) -> None:
    host, _controller, _moved, w32 = harness
    w32.foreground = 4242
    host.dispatch("show_postgame", (with_opponent(),))
    window = host.window(POSTGAME)
    w32.foreground = 5151
    window._tick()
    host.dispatch("hide_postgame", ("checkin-1", "opened_web"))
    assert not window.isVisible()
    assert w32.restored == []


def test_keyboard_focus_moves_with_the_opponent_list(harness, app) -> None:
    host, *_ = harness
    window = show_postgame(host, with_opponent())
    window.activateWindow()
    app.processEvents()
    if QtWidgets.QApplication.activeWindow() is not window:
        pytest.skip("this platform cannot activate the card")
    window.opp_change.click()
    app.processEvents()
    assert window.opp_builds.search.hasFocus()
    QtTest.QTest.mouseClick(window.opp_builds.row("custom:ling-flood"), QtCore.Qt.LeftButton)
    app.processEvents()
    assert window.opp_change.hasFocus()


@pytest.mark.parametrize("kind", [LOADING, POSTGAME])
def test_expanding_build_names_keeps_the_pick_and_native_window(harness, app, kind) -> None:
    host, controller, *_ = harness
    name = "PvZ - Stargate pressure into a third base, Chargelots and a late-game Carrier transition " * 3
    build = option("long-build", name, 12, 8, rolled=True)
    if kind == LOADING:
        window = show_loading(host, loading_model(featured=(build,), more=()))
    else:
        window = show_postgame(host, postgame_model(
            featured=(build,), more=(), selection=build.key,
            reason="detected", reason_label="Detected in your replay",
        ))
    row = window.builds.row(build.key)
    native, flags = window.winId(), window.windowFlags()
    controller.calls.clear()
    window.builds.names_toggle.click()
    app.processEvents()
    window.settle()
    assert window.card.width() > window.WIDTH
    assert row.height() > 30
    assert row.toolTip() == ""  # the full name is now visible
    text = row._name_layout()
    assert text.lineCount() > 1
    last_line = text.lineAt(text.lineCount() - 1)
    assert last_line.textStart() + last_line.textLength() == len(name)
    assert text.boundingRect().bottom() + 6 < row._layout()[3].top()
    assert window.windowFlags() == flags and window.winId() == native
    assert not any(call in {"declare", "update_draft", "confirm"} for call, _args in controller.calls)
    if kind == POSTGAME:
        assert window.selection() == build.key
        assert "Detected in your replay" in [chip[0] for chip in row.chips]
    else:
        assert window.builds.names_toggle.focusPolicy() == QtCore.Qt.NoFocus
    window.builds.names_toggle.click()
    app.processEvents()
    window.settle()
    assert window.card.width() == window.WIDTH
    assert row.height() == 30 and row.toolTip() == name


def test_expanded_names_follow_refresh_search_and_opponent_picker(harness, app) -> None:
    host, controller, *_ = harness
    name = "Zerg - " + "LingBaneRoachRavagerTransition" * 15
    window = show_postgame(host, with_opponent(opponent=opp_model(
        featured=(option("zerg-12-pool", name, 5, 4),), more=(), name=name,
    )))
    window.opp_change.click()
    controller.calls.clear()
    window.opp_builds.names_toggle.click()
    app.processEvents()
    window.settle()
    row = window.opp_builds.row("zerg-12-pool")
    assert row.height() > 30
    assert window.opp_builds.selection() == "zerg-12-pool"
    assert window.builds.names_toggle.isChecked()
    assert not window._opp_touched
    assert controller.named("update_draft") == []
    window.opp_builds.search.setText("LingBane")
    window.opp_builds.search.textEdited.emit("LingBane")
    host.dispatch("update_postgame", (with_opponent(opponent=opp_model(
        featured=(option("zerg-12-pool", name * 2, 5, 4),), more=(), name=name * 2,
    )),))
    app.processEvents()
    window.settle()
    assert window.opp_builds.row("zerg-12-pool") is row
    assert row.name == name * 2 and row.toolTip() == ""
    assert window.opp_builds.selection() == "zerg-12-pool"
    assert window.opp_builds.visible_keys() == ["zerg-12-pool"]


def test_expanded_card_stays_on_screen_with_scrollable_long_builds(harness, app) -> None:
    host, controller, *_ = harness
    builds = tuple(option(f"long-{i}", f"Build {i}: " + "Macro transition " * 100) for i in range(5))
    window = show_postgame(host, postgame_model(featured=builds, more=(), selection="long-0"))
    available = window.screen().availableGeometry()
    window.move(available.right() - window.width() + 1, available.top())
    window.builds.names_toggle.click()
    app.processEvents()
    window.settle()
    assert available.contains(window.geometry())
    assert window.content_scroll.verticalScrollBar().maximum() > 0
    window.content_scroll.ensureWidgetVisible(window.primary)
    app.processEvents()
    point = window.primary.mapTo(window.content_scroll.viewport(), window.primary.rect().center())
    assert window.content_scroll.viewport().rect().contains(point)
    assert controller.named("confirm") == []


def test_expanded_more_builds_can_scroll_to_the_last_full_name(harness, app) -> None:
    host, *_ = harness
    more = tuple(option(f"long-{i}", f"Catalog build {i}: " + "Macro transition " * 30) for i in range(10))
    window = show_loading(host, loading_model(more=more))
    window.builds.names_toggle.click()
    window.builds.more_toggle.click()
    app.processEvents()
    window.settle()
    last = window.builds.row("long-9")
    window.builds.more_area.ensureWidgetVisible(last, 0, 0)
    app.processEvents()
    point = last.mapTo(window.builds.more_area.viewport(), last.rect().bottomLeft())
    assert window.builds.more_area.viewport().rect().contains(point)
    assert last.height() > 30 and last.toolTip() == ""
