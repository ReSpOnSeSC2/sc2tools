from __future__ import annotations

from copy import deepcopy
import time

import pytest

from sc2tools_agent.team_roster import TeamRoster
from tests.test_companion_ghost_page import ghost_page, target, wait_until


def team_snapshot():
    return {"paired": True, "accountKey": "current-owner", "liveGame": {
        "gameKey": "current-team-game", "phase": "match_in_progress", "isReplay": False,
        "capturedAt": time.time(), "displayTime": 125,
        "user": {"name": "Own player", "race": "Protoss"},
        "players": [
            {"id": 1, "name": "Own player", "race": "Protoss", "type": "user", "team": 1},
            {"id": 2, "name": "Ally", "race": "Terran", "type": "user", "team": 1},
            {"id": 3, "name": "Enemy one", "race": "Zerg", "type": "user", "team": 2},
            {"id": 4, "name": "Enemy two", "race": "Protoss", "type": "user", "team": 2},
        ],
    }}


def team_context(snapshot):
    roster = TeamRoster()
    roster.update(snapshot)
    assert roster.ready
    return {"gameKey": roster.candidate["gameKey"], "accountKey": roster.candidate["accountKey"],
            "ownKey": roster.own_key, "user": roster.player(roster.own_key),
            "rosterSignature": roster.signature, "selectedEnemyKey": roster.selected_key,
            "confirmed": True, "enemyKeys": list(roster.enemy_keys)}


def preview(page, race="Protoss"):
    page._show_targets({"players": [{"id": "local-player", "name": "Replay player", "race": race,
                                   "manualOnly": True, "matchup": None, "target": target()}]})


def current_owner_team_snapshot(page, app, saved):
    source = team_snapshot()
    page.update_snapshot(source)
    wait_until(app, lambda: page._account_key == source["accountKey"] and not page._busy)
    assert page._state["slots"] == saved[0]["slots"]
    assert "PvT" in page._state["slots"]
    return source


def test_manual_team_source_can_only_arm_explicitly_for_current_same_race_roster(ghost_page):
    page, app, saved, calls, threads = ghost_page
    source = current_owner_team_snapshot(page, app, saved)
    page.set_team_context(team_context(source))
    page.set_assistance_enabled(True)
    before = deepcopy(saved[0])
    preview(page)
    assert not page.arm_button.isEnabled()
    assert page.team_arm_button.isEnabled()
    assert page._preview_matchup is None
    assert not page.panel.isVisible()
    actions_before = deepcopy(calls)
    page.team_arm_button.click()
    assert page.panel.isVisible()
    assert "Team · Protoss" in page.panel.subtitle.text()
    assert page.panel.title.text() == target()["name"]
    assert "Target +25s" == page.panel.steps.topLevelItem(1).text(3)
    assert "not verified production" in page.status.text()
    assert saved[0] == before and calls == actions_before
    assert page._state["slots"]["PvT"]["name"] == before["slots"]["PvT"]["name"]
    source["liveGame"]["displayTime"] = 150
    page.update_snapshot(source)
    assert page.panel.isVisible() and "2:30" in page.panel.subtitle.text()


def test_manual_team_off_and_master_or_mode_off_clear_temporary_choice_without_erasing_one_on_one_slots(ghost_page):
    page, app, saved, calls, threads = ghost_page
    source = current_owner_team_snapshot(page, app, saved)
    page.set_team_context(team_context(source))
    page.set_assistance_enabled(True)
    preview(page)
    original_slots = deepcopy(page._state["slots"])
    page.team_arm_button.click()
    page.set_assistance_enabled(False, "Teams preset hides Ghost")
    assert not page.panel.isVisible()
    assert not page.team_arm_button.isEnabled()
    page.set_assistance_enabled(True)
    assert not page.panel.isVisible()
    assert page.team_arm_button.isEnabled()
    page.team_arm_button.click()
    assert page.panel.isVisible()
    page._set_enabled(False)
    wait_until(app, lambda: not page._busy and not page._pending_saves)
    assert not page.panel.isVisible()
    page._set_enabled(True)
    wait_until(app, lambda: not page._busy and not page._pending_saves)
    assert not page.panel.isVisible()
    assert page._state["slots"] == original_slots
    assert page.team_arm_button.isEnabled()


def test_team_race_mismatch_stale_telemetry_replay_new_game_and_enemy_change_never_rearm_implicitly(ghost_page):
    page, app, saved, calls, threads = ghost_page
    source = current_owner_team_snapshot(page, app, saved)
    selected = team_context(source)
    page.set_team_context(selected)
    page.set_assistance_enabled(True)
    preview(page, "Terran")
    assert not page.team_arm_button.isEnabled()
    page._arm_team()
    assert not page.panel.isVisible() and "own race" in page.notice.text()
    preview(page)
    page.team_arm_button.click()
    assert page.panel.isVisible()
    selected["selectedEnemyKey"] = next(key for key in selected["enemyKeys"] if key != selected["selectedEnemyKey"])
    page.set_team_context(selected)
    assert not page.panel.isVisible()
    page.team_arm_button.click()
    assert page.panel.isVisible()
    for changes in ({"isReplay": True}, {"capturedAt": time.time() - 100}, {"gameKey": "another-game"}):
        changed = deepcopy(source)
        changed["liveGame"].update(changes)
        page.update_snapshot(changed)
        assert not page.panel.isVisible()
        assert not page.team_arm_button.isEnabled()
        page.update_snapshot(source)
        page.set_team_context(selected)
        assert not page.panel.isVisible()
        page.team_arm_button.click()
        assert page.panel.isVisible()


def test_one_on_one_source_can_be_used_manually_in_teams_without_changing_saved_matchup(ghost_page):
    page, app, saved, calls, threads = ghost_page
    source = current_owner_team_snapshot(page, app, saved)
    page.set_team_context(team_context(source))
    page.set_assistance_enabled(True)
    page._show_targets({"target": target(), "matchup": "PvT"})
    assert page.arm_button.isEnabled()
    assert page.team_arm_button.isEnabled()
    before = deepcopy(saved[0])
    page.team_arm_button.click()
    assert page.panel.isVisible()
    assert saved[0] == before
