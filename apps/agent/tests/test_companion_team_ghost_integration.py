from __future__ import annotations

from copy import deepcopy

from sc2tools_agent.companion_ghost import normalize_ghost_state
from .test_companion_team_roster import companion, confirm, team_snapshot
from .test_companion_page import wait_until


def target():
    return {"v": 1, "name": "Explicit team opener", "sourceGameId": "local:team:1", "steps": [
        {"name": "Gateway", "kind": "building", "t": 43, "timing": "started", "supply": 16},
        {"name": "Stalker", "kind": "unit", "t": 80, "timing": "completed", "supply": 22},
    ]}


def prepare_team(page, state, app):
    team_snapshot(state)
    state["snapshot"]["modes"]["active"] = "teams"
    page.refresh()
    wait_until(app, lambda: bool(page.team_roster_state.candidate) and page._modes["active"] == "teams")
    wait_until(app, lambda: not page.ghost_page._busy)
    ghost = page.ghost_page
    ghost.apply_account_result({"ghost": normalize_ghost_state({
        "v": 1, "enabled": True, "slots": {"PvT": target()},
    })})
    ghost._show_targets({"players": [{"name": "Replay Protoss", "race": "Protoss", "matchup": None,
                                     "manualOnly": True, "target": target()}]})
    return ghost


def test_confirmed_team_mode_allows_explicit_ghost_without_auto_matching_a_saved_one_on_one_slot(companion):
    page, state, app = companion
    ghost = prepare_team(page, state, app)
    assert not ghost._assistance_enabled
    assert not ghost.team_arm_button.isEnabled()
    assert not ghost.panel.isVisible()
    keys = confirm(page)
    assert page.mode_gates()["ghost"] is True
    assert ghost._assistance_enabled
    assert ghost.team_arm_button.isEnabled()
    assert not ghost.panel.isVisible()
    before = deepcopy(ghost._state["slots"])
    ghost.team_arm_button.click()
    assert ghost.panel.isVisible()
    assert "Team · Protoss" in ghost.panel.subtitle.text()
    assert not any(call["action"] == "ghost_save" for call in state["calls"])
    assert ghost._state["slots"] == before
    page._select_team_enemy(keys["Library two"])
    assert not ghost.panel.isVisible()
    assert ghost.team_arm_button.isEnabled()
    ghost.team_arm_button.click()
    assert ghost.panel.isVisible()
    page.set_preference("overlaysEnabled", False)
    wait_until(app, lambda: not page._preference_busy)
    assert not ghost.panel.isVisible() and not ghost.team_arm_button.isEnabled()
    page.set_preference("overlaysEnabled", True)
    wait_until(app, lambda: not page._preference_busy)
    assert ghost.team_arm_button.isEnabled()
    assert not ghost.panel.isVisible()
    assert ghost._state["slots"] == before


def test_mode_ghost_gate_and_own_race_change_stop_manual_target_without_reusing_it(companion):
    page, state, app = companion
    ghost = prepare_team(page, state, app)
    confirm(page)
    ghost.team_arm_button.click()
    assert ghost.panel.isVisible()
    page._modes["profiles"]["teams"]["ghost"] = False
    page._update_overlays()
    assert not ghost.panel.isVisible() and not ghost.team_arm_button.isEnabled()
    page._modes["profiles"]["teams"]["ghost"] = True
    page._update_overlays()
    assert ghost.team_arm_button.isEnabled() and not ghost.panel.isVisible()
    ghost.team_arm_button.click()
    assert ghost.panel.isVisible()
    state["snapshot"]["liveGame"]["players"][0]["race"] = "Zerg"
    state["snapshot"]["liveGame"]["user"]["race"] = "Zerg"
    page.refresh()
    wait_until(app, lambda: page.team_roster_state.player(page.team_roster_state.own_key)["race"] == "Zerg")
    assert not ghost.panel.isVisible() and not ghost.team_arm_button.isEnabled()
