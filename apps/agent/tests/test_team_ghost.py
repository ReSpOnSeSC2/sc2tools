from __future__ import annotations

from copy import deepcopy

import pytest

from sc2tools_agent.companion_ghost import GhostError, TeamGhostSession
from sc2tools_agent.team_roster import TeamRoster


def snapshot():
    return {"paired": True, "accountKey": "account-one", "liveGame": {
        "gameKey": "team-game", "phase": "match_in_progress", "isReplay": False,
        "capturedAt": 1000, "displayTime": 125, "user": {"name": "Own player", "race": "Protoss"},
        "players": [
            {"id": 1, "name": "Own player", "race": "Protoss", "type": "user", "team": 1},
            {"id": 2, "name": "Ally", "race": "Terran", "type": "user", "team": 1},
            {"id": 3, "name": "Enemy one", "race": "Zerg", "type": "user", "team": 2},
            {"id": 4, "name": "Enemy two", "race": "Protoss", "type": "user", "team": 2},
        ],
    }}


def context(source):
    roster = TeamRoster()
    roster.update(source, now=1000)
    assert roster.ready
    return {"gameKey": roster.candidate["gameKey"], "accountKey": roster.candidate["accountKey"],
            "ownKey": roster.own_key, "user": roster.player(roster.own_key),
            "rosterSignature": roster.signature, "selectedEnemyKey": roster.selected_key,
            "confirmed": True, "enemyKeys": list(roster.enemy_keys)}


def target():
    return {"v": 1, "name": "Manual Blink build", "sourceGameId": "local:source:1", "steps": [
        {"t": 50, "name": "Gateway", "kind": "building", "timing": "started", "supply": 16},
        {"t": 100, "name": "Stalker", "kind": "unit", "timing": "completed", "supply": 22},
        {"t": 200, "name": "Blink", "kind": "upgrade", "timing": "completed", "supply": None},
    ]}


def armed_session():
    source = snapshot()
    selected = context(source)
    session = TeamGhostSession()
    session.update_snapshot(source, now=1000)
    session.update_context(selected, now=1000)
    session.arm(target(), "Protoss", now=1000)
    return session, source, selected


def test_team_target_is_explicit_race_matched_and_follows_only_the_recorded_schedule():
    source = snapshot()
    session = TeamGhostSession()
    session.update_snapshot(source, now=1000)
    session.update_context(context(source), now=1000)
    assert session.view(now=1000)[0] is None
    assert "explicitly" in session.view(now=1000)[1]
    assert session.can_arm("P", now=1000)
    assert not session.can_arm("Terran", now=1000)
    with pytest.raises(GhostError, match="own race"):
        session.arm(target(), "Terran", now=1000)
    session.arm(target(), "P", now=1000)
    view, status = session.view(now=1000)
    assert view["manualTeam"] is True and view["matchup"] == "Team · Protoss"
    assert view["clock"] == 125 and view["index"] == 1 and view["passed"] == 2
    assert view["target"]["steps"][1]["timing"] == "completed"
    assert "not verified production" in status
    source["liveGame"]["displayTime"] = 250
    session.update_snapshot(source, now=1000)
    assert session.view(now=1000)[0]["complete"] is True


@pytest.mark.parametrize("change", [
    lambda source: source.update(paired=False),
    lambda source: source.update(accountKey="different-owner"),
    lambda source: source.pop("accountKey"),
    lambda source: source["liveGame"].update(gameKey="new-game"),
    lambda source: source["liveGame"].update(phase="menu"),
    lambda source: source["liveGame"].update(phase="match_ended"),
    lambda source: source["liveGame"].update(isReplay=True),
    lambda source: source["liveGame"].update(capturedAt=969),
    lambda source: source["liveGame"].update(capturedAt=1010),
    lambda source: source["liveGame"]["players"][0].update(race="Random"),
    lambda source: source["liveGame"]["players"][0].update(name="New own player"),
    lambda source: source["liveGame"]["players"][0].update(id=20),
    lambda source: source["liveGame"]["players"][1].update(type="computer"),
    lambda source: source["liveGame"]["players"][1].update(isObserver=True),
    lambda source: source["liveGame"]["players"][1].update(team=2),
    lambda source: source["liveGame"].update(players=source["liveGame"]["players"][:2]),
])
def test_changed_expired_or_untrusted_context_clears_target_and_cannot_resurrect_it(change):
    session, source, selected = armed_session()
    original = deepcopy(source)
    change(source)
    session.update_snapshot(source, now=1000)
    assert session.view(now=1000)[0] is None
    session.update_snapshot(original, now=1000)
    session.update_context(selected, now=1000)
    assert session.view(now=1000)[0] is None
    assert "explicitly" in session.view(now=1000)[1]


def test_changing_selected_enemy_own_player_or_confirmation_requires_explicit_rearm():
    session, source, selected = armed_session()
    selected["selectedEnemyKey"] = next(key for key in selected["enemyKeys"] if key != selected["selectedEnemyKey"])
    session.update_context(selected, now=1000)
    assert session.view(now=1000)[0] is None
    session.arm(target(), "P", now=1000)
    selected["confirmed"] = False
    session.update_context(selected, now=1000)
    assert session.view(now=1000)[0] is None
    selected["confirmed"] = True
    session.update_context(selected, now=1000)
    assert session.view(now=1000)[0] is None
    session.arm(target(), "P", now=1000)
    roster = TeamRoster()
    roster.update(source, now=1000)
    own = next(row for row in roster.players if row["name"] == "Ally")
    selected["ownKey"] = own["key"]
    selected["user"] = own
    session.update_context(selected, now=1000)
    assert not session.can_arm("P", now=1000)
    assert session.can_arm("T", now=1000)
    assert session.view(now=1000)[0] is None


def test_loading_target_waits_for_start_and_clock_gaps_never_guess_progress():
    session, source, selected = armed_session()
    source["liveGame"]["phase"] = "match_loading"
    session.update_snapshot(source, now=1000)
    assert session.view(now=1000)[0] is None
    assert "ready" in session.view(now=1000)[1]
    source["liveGame"]["phase"] = "match_started"
    source["liveGame"]["displayTime"] = None
    session.update_snapshot(source, now=1000)
    assert session.view(now=1000)[0] is None
    source["liveGame"]["displayTime"] = 126
    session.update_snapshot(source, now=1000)
    assert session.view(now=1000)[0]["clock"] == 126
    assert session.view(now=1031)[0] is None
    source["liveGame"]["capturedAt"] = 1031
    session.update_snapshot(source, now=1031)
    assert session.view(now=1031)[0] is None


def test_returned_target_and_input_context_are_isolated_and_manual_clear_is_not_a_saved_slot():
    session, source, selected = armed_session()
    view, _status = session.view(now=1000)
    view["target"]["steps"][0]["t"] = 500
    source["liveGame"]["players"].clear()
    selected["enemyKeys"].clear()
    assert session.view(now=1000)[0]["target"]["steps"][0]["t"] == 50
    session.clear_target()
    assert session.view(now=1000)[0] is None
