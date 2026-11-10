"""The floating scouting report lists each player's last five games."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import os
import re
import time

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui import theme
from sc2tools_agent.ui.companion_page import _keep_live_history, _live_context, build_companion_page
from sc2tools_agent.ui.companion_speech import build_scouting_report
from tests._gui_offscreen import run_gui_check
from tests.test_companion_build_range_scope import build_calls, desk_factory, replay, stored_order, wait_until
from tests.test_companion_page import companion
from tests.test_companion_team_roster import confirm, team_snapshot

DOT = " \N{MIDDLE DOT} "


# One fixed moment for the whole run, so two payloads built in a test are equal.
NEWEST = datetime.now(timezone.utc) - timedelta(hours=1)


def rows(side, count, **overrides):
    return [{"gameId": f"{side}-{index}", "result": "Loss" if index % 2 else "Win", "map": f"Map {index}",
             "build": f"{side} build {index}", "date": (NEWEST - timedelta(days=index)).isoformat(), **overrides}
            for index in range(count)]


def lists(mine=5, theirs=5):
    return {"matchup": "PvZ", "mine": rows("my", mine), "theirs": rows("opp", theirs, race="Zerg")}


def context(mine=5, theirs=5, **history):
    return {"name": "NorthStar", "race": "Zerg", "mmr": 4310, "headToHead": {"wins": 3, "losses": 2},
            "recentBuilds": lists(mine, theirs), **history}


def live_game(history, key="live-match"):
    return {"phase": "match_in_progress", "gameKey": key, "capturedAt": time.time(),
            "opponent": {"name": "NorthStar", "race": "Zerg", "profile": {"mmr": 4310}},
            "streamerHistory": {"oppName": "NorthStar", **history}}


@pytest.fixture
def report():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.timer.stop()
    panel = page.overlays["scouting"]
    yield panel, app
    page.shutdown()
    page.deleteLater()
    app.processEvents()


def shown(panel, app, live):
    panel.update_context(live)
    panel.show()
    app.processEvents()
    return panel.recent_builds.columns


def test_five_games_on_each_side_replace_the_one_replay_picker(report):
    panel, app = report
    columns = shown(panel, app, context())
    assert panel.recent_builds.isVisible() and not panel.games.isVisible()
    assert columns["my"].heading.text() == "YOU" + DOT + "PvZ" + DOT + "LAST 5 GAMES"
    assert columns["opp"].heading.text() == "OPPONENT" + DOT + "LAST 5 GAMES VS YOU"
    for side in ("my", "opp"):
        games = columns[side].rows()
        assert [row.build.accessibleName() for row in games] == [f"{side} build {index}" for index in range(5)]
        assert [row.isChecked() for row in games] == [True, False, False, False, False]
        assert games[1].result.text() == "Loss" and games[1].details.accessibleName() == "Map 1" + DOT + "yesterday"
        assert not columns[side].empty.isVisible()
    assert panel.comparison.chain_labels["my"].text() == "my build 0"
    assert panel.comparison.chain_labels["opp"].text() == "opp build 0"
    assert panel.comparison_title.text() == "BUILD ORDERS" + DOT + "SELECTED GAMES"
    assert panel.detail.text().startswith("Results are yours")


def test_every_row_is_plain_text_with_one_accessible_sentence(report):
    panel, app = report
    live = context()
    live["recentBuilds"]["theirs"][0]["build"] = "<b>12 Pool</b>"
    row = shown(panel, app, live)["opp"].rows()[0]
    assert row.build.textFormat() == QtCore.Qt.PlainText and row.result.textFormat() == QtCore.Qt.PlainText
    assert row.accessibleName() == row.toolTip() == "Win against <b>12 Pool</b>" + DOT + "Map 0" + DOT + "today"
    assert row.focusPolicy() == QtCore.Qt.StrongFocus


def test_a_row_opens_its_own_players_build_and_leaves_the_other_card_alone(report):
    panel, app = report
    columns = shown(panel, app, context())
    columns["my"].rows()[2].click()
    app.processEvents()
    assert panel.comparison.chain_labels["my"].text() == "my build 2"
    assert panel.comparison.chain_labels["opp"].text() == "opp build 0"
    assert panel._keys["my"][1] == "my-2" and panel._keys["opp"][1] == "opp-0"
    assert columns["my"].rows()[2].build.property("selected") == "true"
    assert columns["my"].rows()[0].build.property("selected") == "false"
    columns["opp"].rows()[4].click()
    app.processEvents()
    assert panel.comparison.chain_labels["opp"].text() == "opp build 4"
    assert panel.comparison.chain_labels["my"].text() == "my build 2"
    assert [row.isChecked() for row in columns["opp"].rows()] == [False, False, False, False, True]


def test_fewer_than_five_games_say_how_many_there_are(report):
    panel, app = report
    columns = shown(panel, app, context(2, 3))
    assert columns["my"].heading.text() == "YOU" + DOT + "PvZ" + DOT + "2 EARLIER GAMES"
    assert columns["opp"].heading.text() == "OPPONENT" + DOT + "3 EARLIER GAMES VS YOU"
    assert len(columns["my"].rows()) == 2 and len(columns["opp"].rows()) == 3


def test_a_first_meeting_shows_your_games_and_says_so_for_the_opponent(report):
    panel, app = report
    columns = shown(panel, app, context(5, 0, headToHead={"wins": 0, "losses": 0}))
    assert columns["opp"].heading.text() == "OPPONENT" + DOT + "FIRST MEETING"
    assert columns["opp"].empty.isVisible()
    assert columns["opp"].empty.text() == "No earlier games against this player in your library."
    assert columns["opp"].rows() == [] and len(columns["my"].rows()) == 5
    assert panel.comparison.chain_labels["opp"].text() == "No earlier game"
    assert panel.comparison.chain_labels["my"].text() == "my build 0"
    assert panel._keys["opp"] is None and panel._keys["my"][1] == "my-0"
    assert not panel.comparison.chain_reference_buttons["opponent"].isEnabled()


def test_an_older_payload_without_the_lists_draws_todays_report(report):
    panel, app = report
    legacy = {"name": "NorthStar", "last5GamesScouting": [{**replay("first"), "map": "Old map"}, replay("second")]}
    panel.update_context(legacy)
    panel.show()
    app.processEvents()
    assert panel.games.isVisible() and not panel.recent_builds.isVisible()
    assert panel.games.count() == 2 and panel.games.currentData() == "first"
    assert panel.comparison_title.text() == "BUILD VS BUILD" + DOT + "Old map"
    assert panel.detail.text() == "Previous games against this opponent" + DOT + "replay timings"
    assert panel.comparison.chain_labels["my"].text() == "Gateway opening"
    assert panel._keys["my"] == panel._keys["opp"] and panel._keys["opp"][1] == "first"
    shown(panel, app, {**legacy, "recentBuilds": lists(1, 1)})
    assert panel.recent_builds.isVisible() and not panel.games.isVisible()
    panel.update_context(legacy)
    assert panel.games.isVisible() and not panel.recent_builds.isVisible()


def test_a_refresh_keeps_the_chosen_game_and_a_new_opponent_starts_at_the_newest(report):
    panel, app = report
    columns = shown(panel, app, context())
    columns["opp"].rows()[3].click()
    panel.update_context(context())
    assert [row.isChecked() for row in columns["opp"].rows()] == [False, False, False, True, False]
    newer = context()
    newer["recentBuilds"]["theirs"] = rows("fresh", 1, race="Zerg") + newer["recentBuilds"]["theirs"][:4]
    panel.update_context(newer)
    app.processEvents()
    assert [row.model.game_id for row in columns["opp"].rows() if row.isChecked()] == ["opp-3"]
    assert len(columns["opp"].rows()) == 5
    panel.update_context({**context(), "name": "Somebody else"})
    assert [row.isChecked() for row in columns["opp"].rows()] == [True, False, False, False, False]
    assert panel.comparison.chain_labels["opp"].text() == "opp build 0"


def test_a_new_game_opens_at_its_newest_games_when_its_first_context_had_no_lists(report):
    panel, app = report
    columns = shown(panel, app, context())
    panel.update_context(context(), scope="game-1")
    columns["my"].rows()[1].click()
    columns["opp"].rows()[2].click()
    # The next game's first snapshot arrives before its enrichment; a rematch
    # then brings the same earlier games.
    panel.update_context({"name": "NorthStar", "race": "Zerg"}, scope="game-2")
    panel.update_context(context(), scope="game-2")
    for side in ("my", "opp"):
        assert [row.isChecked() for row in columns[side].rows()] == [True, False, False, False, False]
    assert panel.comparison.chain_labels["opp"].text() == "opp build 0"


def test_an_opponent_not_identified_yet_is_not_called_a_first_meeting(report):
    panel, app = report
    live = context()
    live["recentBuilds"]["theirs"] = None
    columns = shown(panel, app, live)
    assert columns["opp"].heading.text() == "OPPONENT" + DOT + "NOT IDENTIFIED YET"
    assert columns["opp"].empty.isVisible() and columns["opp"].rows() == []
    assert len(columns["my"].rows()) == 5
    panel.owner._build_order_cache[panel._keys["my"]] = {"my": [], "opp": [], "statuses": {"my": "ok", "opp": "ok"}}
    panel.render_build_data()
    assert panel.source_status.toolTip() == "Stored replay events" + DOT + "You: 0" + DOT + "Opponent: not identified yet. Older uploads may be incomplete."


def _luminance(color):
    channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(first, second):
    light, dark = sorted((_luminance(first), _luminance(second)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def test_the_chosen_row_is_as_readable_as_the_others(report):
    panel, app = report
    style = panel.recent_builds.styleSheet()
    chosen = re.search(r"QPushButton:checked \{ background: (#[0-9a-fA-F]{6})", style).group(1)
    for text in (theme.SUCCESS, theme.DANGER, theme.TEXT_MUTED, theme.ACCENT_CYAN):
        assert _contrast(text, chosen) >= 4.5, (text, chosen)


def test_a_game_against_this_opponent_previews_its_milestones_until_stored_events_load(report):
    panel, app = report
    shown(panel, app, context(last5GamesScouting=[replay("opp-0"), replay("my-1")]))
    assert [step.observation["name"] for step in panel.comparison.build_chains["opp"].steps] == ["Factory"]
    assert panel.comparison.build_chains["my"].steps == []
    panel.recent_builds.columns["my"].rows()[1].click()
    app.processEvents()
    assert [step.observation["name"] for step in panel.comparison.build_chains["my"].steps] == ["CyberneticsCore"]
    assert "loading stored replay events" in panel.source_status.toolTip()


@pytest.mark.parametrize("size,order", [((420, 300), ["opp", "my"]), ((500, 450), ["opp", "my"]), ((650, 450), ["my", "opp"])])
def test_the_lists_fit_every_report_size_and_the_smallest_opens_on_the_opponent(report, size, order):
    panel, app = report
    live = context()
    live["recentBuilds"]["theirs"][0]["build"] = "Zerg - " + "A very long opening name " * 8
    columns = shown(panel, app, live)
    panel.resize(*size)
    app.processEvents()
    grid = panel.recent_builds.grid
    placed = sorted(columns, key=lambda side: grid.getItemPosition(grid.indexOf(columns[side]))[:2])
    assert placed == order
    assert panel.scouting_scroll.horizontalScrollBar().maximum() == 0
    viewport = panel.scouting_scroll.viewport()
    for side in ("my", "opp"):
        for row in columns[side].rows():
            panel.scouting_scroll.ensureWidgetVisible(row)
            app.processEvents()
            rectangle = QtCore.QRect(row.mapTo(viewport, QtCore.QPoint()), row.size())
            assert viewport.rect().contains(rectangle), (size, side, rectangle, viewport.rect())
            assert row.rect().contains(row.build.geometry()) and row.rect().contains(row.details.geometry())
    assert columns["opp"].rows()[0].build.text().endswith("\N{HORIZONTAL ELLIPSIS}")


@pytest.mark.parametrize("scale_factor", ["1", "1.5"])
def test_the_lists_stay_inside_the_themed_frame_when_windows_scales_the_text(tmp_path, monkeypatch, scale_factor):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale_factor)
    run_gui_check(tmp_path, '''
        import os
        from sc2tools_agent.ui import theme
        from sc2tools_agent.ui.companion_page import build_companion_page

        fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
            if (fonts / filename).is_file():
                QtGui.QFontDatabase.addApplicationFont(str(fonts / filename))
        app.setFont(QtGui.QFont("Segoe UI", 10))
        app.setStyleSheet(theme.STYLE)
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        panel = page.overlays["scouting"]
        games = [{"gameId": "g%d" % index, "result": "Win", "map": "A long map name LE", "build": "PvZ - A long build name %d" % index,
                  "date": "2026-11-0%dT12:00:00Z" % (index + 1)} for index in range(5)]
        panel.update_context({"name": "NorthStar Example Opponent", "race": "Zerg",
                              "recentBuilds": {"matchup": "PvZ", "mine": games, "theirs": games}})
        try:
            for skin in ("default", "zerg"):
                panel.set_appearance(skin, False)
                for width, height in ((420, 300), (650, 450)):
                    panel.resize(width, height)
                    panel.show()
                    QtTest.QTest.qWait(10)
                    safe = QtCore.QRect(32, 30, width - 64, height - 58)
                    assert safe.contains(panel.scouting_scroll.geometry())
                    assert panel.scouting_scroll.horizontalScrollBar().maximum() == 0
                    viewport = panel.scouting_scroll.viewport()
                    for column in panel.recent_builds.columns.values():
                        for row in column.rows():
                            panel.scouting_scroll.ensureWidgetVisible(row)
                            QtTest.QTest.qWait(2)
                            rectangle = QtCore.QRect(row.mapTo(viewport, QtCore.QPoint()), row.size())
                            assert viewport.rect().contains(rectangle), (skin, (width, height), rectangle, viewport.rect())
                            assert row.height() >= row.build.height() + row.details.height()
        finally:
            page.shutdown()
            page.deleteLater()
            app.processEvents()
    ''', timeout=60)


def start_live_game(page, history, **preferences):
    page._preferences.update(overlaysEnabled=True, scoutingOverlay=True, **preferences)
    page._snapshot = {"paired": True, "liveGame": live_game(history)}
    page._snapshot_healthy = True
    page._update_overlays()
    return page.overlays["scouting"]


def test_each_card_loads_the_stored_events_of_its_own_game(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: page._build_order_inflight is None)
    mine, theirs = stored_order("my-0"), stored_order("opp-0")
    mine["events"] = [{"name": "Stargate", "category": "building", "is_building": True, "time": 150}]
    theirs["opp_events"] = [{"name": "RoachWarren", "category": "building", "is_building": True, "time": 120}]
    state["orders"].update({("live-history", "my-0"): mine, ("live-history", "opp-0"): theirs})
    panel = start_live_game(page, {"pulseId": "live-history", "recentBuilds": lists()})
    assert panel.isVisible()
    wait_until(app, lambda: all(key in page._build_order_cache for key in panel._keys.values()))
    assert [call["gameId"] for call in build_calls(state) if call["opponentId"] == "live-history"] == ["opp-0", "my-0"]
    assert [step.observation["name"] for step in panel.comparison.build_chains["my"].steps] == ["Stargate"]
    assert [step.observation["name"] for step in panel.comparison.build_chains["opp"].steps] == ["RoachWarren"]
    assert "You: 1" + DOT + "Opponent: 1" in panel.source_status.toolTip()
    panel.comparison.chain_reference_buttons["you"].click()
    wait_until(app, lambda: "ghost_target" in state)
    assert (state["ghost_target"]["gameId"], state["ghost_target"]["side"]) == ("my-0", "you")


def test_one_failed_game_can_be_retried_without_losing_the_other(desk_factory):
    page, state, app = desk_factory()
    wait_until(app, lambda: page._build_order_inflight is None)
    state["errors"].add(("live-history", "my-0"))
    panel = start_live_game(page, {"pulseId": "live-history", "recentBuilds": lists()})
    wait_until(app, lambda: panel._keys["my"] in page._build_order_failures and panel._keys["opp"] in page._build_order_cache)
    assert panel.retry.isVisible() and "load failed" in panel.source_status.toolTip()
    state["errors"].clear()
    panel.retry.click()
    wait_until(app, lambda: panel._keys["my"] in page._build_order_cache)
    assert not panel.retry.isVisible() and "Stored replay events" in panel.source_status.toolTip()


def test_a_pinned_report_stays_closed_on_a_first_meeting_until_it_is_asked_for(desk_factory):
    page, state, app = desk_factory()
    panel = start_live_game(page, {"recentBuilds": lists(5, 0)})
    assert page._preferences["scoutingSkipFirstMeeting"] is True
    assert not panel.isVisible()
    assert page.compact_card.scouting_button.isEnabled()
    page.compact_card.scouting_button.click()
    assert panel.isVisible()
    assert panel.recent_builds.columns["opp"].heading.text() == "OPPONENT" + DOT + "FIRST MEETING"
    assert len(panel.recent_builds.columns["my"].rows()) == 5
    page.compact_card.scouting_button.click()
    assert not panel.isVisible()


def test_a_pinned_report_opens_once_the_opponents_games_are_known(desk_factory):
    page, state, app = desk_factory()
    panel = start_live_game(page, {})
    assert not panel.isVisible()
    page._snapshot["liveGame"]["streamerHistory"]["recentBuilds"] = lists(5, 1)
    page._update_overlays()
    assert panel.isVisible()
    page._snapshot = {"paired": True, "liveGame": live_game({"recentBuilds": lists(5, 0)}, key="next-match")}
    page._update_overlays()
    assert not panel.isVisible()


def test_turning_the_setting_off_opens_the_pinned_report_in_every_game(desk_factory):
    page, state, app = desk_factory()
    panel = start_live_game(page, {"recentBuilds": lists(5, 0)}, scoutingSkipFirstMeeting=False)
    assert panel.isVisible()
    assert panel.recent_builds.columns["opp"].heading.text() == "OPPONENT" + DOT + "FIRST MEETING"


def test_an_older_server_counts_its_own_list_of_earlier_games(desk_factory):
    page, state, app = desk_factory()
    panel = start_live_game(page, {"last5GamesScouting": []})
    assert not panel.isVisible()
    page._snapshot["liveGame"]["streamerHistory"]["last5GamesScouting"] = [replay("earlier")]
    page._update_overlays()
    assert panel.isVisible() and panel.games.isVisible()


def deliver(page, live):
    page._requests["snapshot"] = request = object()
    page._completed({"channel": "snapshot", "request": request, "payload": {"action": "snapshot"},
                     "result": {"paired": True, "accountKey": "fixture-owner", "liveGame": live}})


def test_a_poll_before_the_enrichment_resolves_keeps_an_open_report_and_its_lists(desk_factory):
    page, state, app = desk_factory()
    page._preferences.update(overlaysEnabled=True, scoutingOverlay=True)
    panel = page.overlays["scouting"]
    deliver(page, live_game({"recentBuilds": lists(5, 3)}))
    assert panel.isVisible() and panel.recent_builds.isVisible()
    bare = live_game({})
    del bare["streamerHistory"]
    deliver(page, bare)
    assert panel.isVisible() and panel.recent_builds.isVisible() and not panel.games.isVisible()
    assert len(panel.recent_builds.columns["opp"].rows()) == 3
    deliver(page, {**bare, "gameKey": "next-match"})
    assert not panel.isVisible()


def test_a_kept_enrichment_joins_only_the_same_account_game_and_opponent():
    enriched = {"accountKey": "me", "liveGame": live_game({"recentBuilds": lists()})}
    _, kept = _keep_live_history(enriched, None)
    bare = live_game({})
    del bare["streamerHistory"]
    joined, still = _keep_live_history({"accountKey": "me", "liveGame": bare}, kept)
    assert joined["liveGame"]["streamerHistory"]["recentBuilds"] == lists() and still is kept
    assert "streamerHistory" not in bare
    nameless = {**bare, "opponent": {"race": "Zerg"}}
    unnamed, waiting = _keep_live_history({"accountKey": "me", "liveGame": nameless}, kept)
    assert "streamerHistory" not in unnamed["liveGame"] and waiting is kept
    for changed in ({"accountKey": "someone else", "liveGame": bare},
                    {"accountKey": "me", "liveGame": {**bare, "gameKey": "next-match"}},
                    {"accountKey": "me", "liveGame": {**bare, "opponent": {"name": "Rematch rival"}}}):
        result, dropped = _keep_live_history(changed, kept)
        assert "streamerHistory" not in result["liveGame"] and dropped is None
    mismatched = live_game({"recentBuilds": lists()})
    mismatched["streamerHistory"]["oppName"] = "Previous opponent"
    assert _keep_live_history({"accountKey": "me", "liveGame": mismatched}, kept)[1] is None


def test_in_a_team_game_the_pinned_report_follows_the_selected_enemys_history(companion):
    page, state, app = companion
    team_snapshot(state)
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate))
    keys = confirm(page)
    wait_until(app, lambda: set(page._team_details) == {"one", "two"})
    panel = page.overlays["scouting"]
    assert page._preferences["scoutingSkipFirstMeeting"] is True
    assert page.team_roster_state.selected_key == keys["Library one"] and panel.isVisible()
    page._select_team_enemy(keys["Library two"])
    assert not panel.isVisible()
    page._select_team_enemy(keys["Library one"])
    assert panel.isVisible()


def test_the_setting_is_on_by_default_explained_and_saved_like_the_other_choices(companion):
    page, state, app = companion
    checkbox = page.preference_checks["scoutingSkipFirstMeeting"]
    assert checkbox.text() == "Keep scouting closed on a first meeting"
    assert checkbox.isChecked() and page._preferences["scoutingSkipFirstMeeting"] is True
    assert "nothing to say" in checkbox.toolTip() and "Scouting button still opens it" in checkbox.toolTip()
    checkbox.click()
    wait_until(app, lambda: not page._preference_busy)
    assert state["snapshot"]["preferences"]["scoutingSkipFirstMeeting"] is False
    assert not checkbox.isChecked()


def test_a_name_only_match_keeps_the_exact_account_lists_and_drops_the_record():
    snapshot = {"liveGame": live_game({"opponentIdentityMatched": False, "headToHead": {"wins": 9, "losses": 1},
                                       "last5GamesScouting": [replay("another-account")], "recentBuilds": lists(2, 0)})}
    active, live = _live_context(snapshot)
    assert active and live["recentBuilds"] == lists(2, 0) and live["opponentIdentityMatched"] is False
    assert "headToHead" not in live and "last5GamesScouting" not in live
    snapshot["liveGame"]["streamerHistory"]["oppName"] = "Previous opponent"
    assert "recentBuilds" not in _live_context(snapshot)[1]


def test_the_spoken_report_says_nothing_new():
    spoken = {"name": "NorthStar", "race": "Zerg", "mmr": 4310, "headToHead": {"wins": 3, "losses": 2}}
    assert build_scouting_report({**spoken, "recentBuilds": lists()}) == build_scouting_report(deepcopy(spoken))
