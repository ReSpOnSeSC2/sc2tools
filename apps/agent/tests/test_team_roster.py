from copy import deepcopy

import pytest

from sc2tools_agent.team_roster import TeamRoster, roster_candidate


def snapshot(**updates):
    envelope = {"phase": "match_in_progress", "gameKey": "team-one", "isReplay": False,
                "capturedAt": 1000, "displayTime": 60,
                "user": {"name": "Me", "race": "Protoss"},
                "players": [{"id": 1, "name": "Me", "race": "Protoss", "type": "user"},
                            {"id": 2, "name": "Ally", "race": "Terran", "type": "user"},
                            {"id": 3, "name": "Enemy Z", "race": "Zerg", "type": "user"},
                            {"id": 4, "name": "Enemy T", "race": "Terran", "type": "user"}]}
    envelope.update(updates)
    return {"paired": True, "accountKey": "owner-one", "liveGame": envelope}


def confirmed(source=None):
    roster = TeamRoster()
    roster.update(source or snapshot(), now=1000)
    keys = {row["name"]: row["key"] for row in roster.players}
    roster.confirm(keys["Me"], [keys["Enemy Z"], keys["Enemy T"]])
    return roster, keys


def test_team_membership_is_never_inferred_from_player_order_or_race():
    roster = TeamRoster()
    roster.update(snapshot(), now=1000)
    assert not roster.ready
    assert roster.enemy_keys == []
    assert roster.player(roster.own_key)["name"] == "Me"
    roster, keys = confirmed()
    assert roster.ready
    assert {row["name"] for row in roster.enemies} == {"Enemy Z", "Enemy T"}
    assert not roster.select(keys["Ally"])
    assert roster.context()["mmr"] is None


def test_confirm_requires_explicit_self_teammate_and_enemy_not_free_for_all():
    roster = TeamRoster()
    roster.update(snapshot(), now=1000)
    keys = [row["key"] for row in roster.players]
    for own, enemies in ((None, keys[1:]), (keys[0], keys), (keys[0], keys[1:]), (keys[0], []), (keys[0], ["unknown"])):
        with pytest.raises(ValueError):
            roster.confirm(own, enemies)


@pytest.mark.parametrize("change", ["game", "account", "roster", "menu", "unpair"])
def test_new_game_owner_roster_or_terminal_state_clears_confirmations_and_identity_links(change):
    roster, keys = confirmed()
    roster.bind(keys["Enemy Z"], "owned-z", [{"pulseId": "owned-z"}])
    update = snapshot()
    if change == "game":
        update["liveGame"]["gameKey"] = "next-game"
    elif change == "account":
        update["accountKey"] = "different-owner"
    elif change == "roster":
        update["liveGame"]["players"][3]["name"] = "Another T"
    elif change == "menu":
        update["liveGame"]["phase"] = "menu"
    else:
        update["paired"] = False
    assert roster.update(update, now=1000)
    assert not roster.ready
    assert not roster.bindings


def test_selection_survives_reordered_ticks_and_cycles_only_confirmed_enemies():
    roster, keys = confirmed()
    roster.select(keys["Enemy T"])
    source = snapshot()
    source["liveGame"]["players"].reverse()
    assert not roster.update(source, now=1000)
    assert roster.selected_key == keys["Enemy T"]


def test_race_updates_do_not_change_confirmed_membership_or_selected_player():
    roster, keys = confirmed()
    roster.select(keys["Enemy T"])
    source = snapshot()
    source["liveGame"]["players"][3]["race"] = "Zerg"
    assert not roster.update(source, now=1000)
    assert roster.ready
    assert roster.selected_key == keys["Enemy T"]
    assert roster.player(keys["Enemy T"])["race"] == "Zerg"
    roster.step(1)
    assert roster.selected_key == keys["Enemy Z"]
    roster.step(-1)
    assert roster.selected_key == keys["Enemy T"]


def test_complete_team_metadata_can_resolve_sides_only_with_unique_self_and_a_teammate():
    source = snapshot()
    for player in source["liveGame"]["players"]:
        player["team_id"] = 1 if player["id"] <= 2 else 2
    roster = TeamRoster()
    roster.update(source, now=1000)
    assert roster.ready
    assert {row["name"] for row in roster.enemies} == {"Enemy Z", "Enemy T"}
    source["liveGame"]["user"]["name"] = "Unknown local identity"
    roster = TeamRoster()
    roster.update(source, now=1000)
    assert not roster.ready


@pytest.mark.parametrize("kind", ["stale", "future", "replay", "AI", "observer", "source_observer", "unknown_type", "duplicate", "one_on_one"])
def test_unsafe_contexts_do_not_make_a_team_candidate(kind):
    source = snapshot()
    envelope = source["liveGame"]
    if kind == "stale":
        envelope["capturedAt"] = 900
    elif kind == "future":
        envelope["capturedAt"] = 1010
    elif kind == "replay":
        envelope["isReplay"] = True
    elif kind == "source_observer":
        envelope["sourceIsObserver"] = True
    elif kind in {"AI", "observer", "unknown_type"}:
        envelope["players"][2]["type"] = {"AI": "computer", "observer": "observer", "unknown_type": ""}[kind]
    elif kind == "duplicate":
        envelope["players"][3] = deepcopy(envelope["players"][2])
    else:
        envelope["players"] = envelope["players"][:2]
    assert roster_candidate(source, now=1000) is None


def test_only_unique_exact_owned_name_and_race_match_autolinks_and_manual_binding_is_owned():
    roster, keys = confirmed()
    directory = [{"pulseId": "z-one", "name": "Enemy Z", "race": "Zerg"},
                 {"pulseId": "z-two", "name": "Enemy Z", "race": "Zerg"},
                 {"pulseId": "t-one", "name": "[Clan] ENEMY T", "race": "Terran"}]
    roster.bind_directory(directory)
    assert roster.bindings == {keys["Enemy T"]: "t-one"}
    with pytest.raises(ValueError):
        roster.bind(keys["Enemy Z"], "not-in-my-library", directory)
    with pytest.raises(ValueError):
        roster.bind(keys["Ally"], "t-one", directory)
    roster.bind(keys["Enemy Z"], "z-two", directory)
    assert roster.bindings[keys["Enemy Z"]] == "z-two"


def test_duplicate_live_names_are_not_automatically_linked_to_one_historical_identity():
    source = snapshot()
    source["liveGame"]["players"][3].update(name="Enemy Z", race="Zerg")
    roster = TeamRoster()
    roster.update(source, now=1000)
    own = next(row["key"] for row in roster.players if row["name"] == "Me")
    enemies = [row["key"] for row in roster.players if row["name"] == "Enemy Z"]
    roster.confirm(own, enemies)
    roster.bind_directory([{"pulseId": "z-one", "name": "Enemy Z", "race": "Zerg"}])
    assert not roster.bindings


def test_context_keeps_selected_enemy_live_name_and_labels_historical_rating_and_notes():
    roster, keys = confirmed()
    roster.bind(keys["Enemy Z"], "z-one", [{"pulseId": "z-one"}])
    details = {"z-one": {"name": "Historical alias", "mmr": 4100, "totals": {"wins": 2, "losses": 1}, "notes": "My note", "notesReadAloud": True}}
    context = roster.context(details)
    assert context["name"] == "Enemy Z"
    assert context["mmrSource"] == "Historical 1v1 MMR · not team rating"
    assert context["headToHead"] == {"wins": 2, "losses": 1}
    assert context["opponentNotes"] == {"text": "My note", "readAloud": True}
    context["headToHead"]["wins"] = 99
    assert details["z-one"]["totals"]["wins"] == 2
    roster.select(keys["Enemy T"])
    assert roster.context(details)["mmr"] is None
    assert not roster.context(details)["opponentIdentityMatched"]


def test_race_reveal_recomputes_auto_identity_but_preserves_manual_choices_and_team_membership():
    roster, keys = confirmed()
    directory = [{"pulseId": "t-old", "name": "Enemy T", "race": "Terran"},
                 {"pulseId": "z-new", "name": "Enemy T", "race": "Zerg"}]
    roster.bind_directory(directory)
    assert roster.bindings[keys["Enemy T"]] == "t-old"
    roster.bind_directory([])
    assert not roster.bindings
    assert not roster.manual_bindings
    source = snapshot()
    source["liveGame"]["players"][3]["race"] = "Zerg"
    roster.update(source, now=1000)
    roster.bind_directory(directory)
    assert roster.ready
    assert roster.bindings[keys["Enemy T"]] == "z-new"
    roster.bind(keys["Enemy T"], "t-old", directory)
    roster.bind_directory(directory)
    assert roster.bindings[keys["Enemy T"]] == "t-old"
