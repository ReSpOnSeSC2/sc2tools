"""Revealed opponent identities stay scoped to their check-in game."""

import pytest

from sc2tools_agent.build_checkin.render import versus
from sc2tools_agent.build_checkin.scouting import parse_scouting_brief
from tests.build_checkin_fakes import Harness, OPP, cloud_game, envelope, game_state


def loading(h):
    return h.view.last("show_loading", "update_loading")


def postgame(h):
    return h.view.last("show_postgame", "update_postgame")


def brief(key, name="KnownPlayer", opponent=OPP):
    return {"gameKey": key, "oppName": opponent, "oppRevealedName": name,
            "pulseId": "1-S2-1-42"}


def test_revealed_identity_appears_with_scouting_off_and_survives_match_end():
    h = Harness(show_scouting_at_loading=False).boot()
    key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    assert loading(h).title == f"PvZ · vs {OPP} (aka KnownPlayer)"
    assert loading(h).opponent_name == OPP
    assert loading(h).opponent_revealed_name == "KnownPlayer"
    assert loading(h).scouting is None
    h.play(key)
    assert postgame(h).title == f"Victory · PvZ · vs {OPP} (aka KnownPlayer)"
    assert postgame(h).opponent_revealed_name == "KnownPlayer"


def test_loading_checkin_fetches_identity_fallback_with_scouting_hidden():
    h = Harness(show_scouting_at_loading=False).boot(); calls = []
    h.api.get_scouting_brief = lambda key: calls.append(key) or brief(key)
    key = h.new_key(); h.send(envelope("match_loading", key))
    assert calls == [key]
    assert loading(h).title.endswith("(aka KnownPlayer)")
    assert loading(h).scouting is None


def test_wrong_game_and_opponent_cannot_supply_a_revealed_identity():
    h = Harness().boot(); key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief("old-game")); h.pump()
    h.ctl.on_scouting_brief(brief(key, opponent="Someone else")); h.pump()
    assert loading(h).title == f"PvZ · vs {OPP}"
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    new = h.new_key(); h.send(envelope("match_loading", new))
    assert loading(h).title == f"PvZ · vs {OPP}"
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    assert loading(h).title == f"PvZ · vs {OPP}"


def test_delayed_brief_updates_current_postgame_card_without_reopening_loading():
    h = Harness().boot(); key = h.new_key(); h.play(key)
    loading_calls = len(h.view.of("show_loading"))
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    assert postgame(h).title.endswith("(aka KnownPlayer)")
    assert len(h.view.of("show_loading")) == loading_calls
    h.ctl.on_scouting_brief(brief(key, name=None)); h.pump()
    assert postgame(h).title == f"Victory · PvZ · vs {OPP}"


def test_authoritative_replay_identity_clears_a_different_accounts_alias():
    h = Harness().boot(); key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump(); h.play(key)
    replay = cloud_game("game-1", started=int(key.rsplit("|", 1)[1]) / 1000 + 8)
    replay.opponent["toonHandle"] = "1-S2-1-99"
    h.api.games[replay.game_id] = game_state(replay.game_id)
    h.accept(replay)
    assert postgame(h).opponent_revealed_name is None
    assert "KnownPlayer" not in postgame(h).title
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    assert postgame(h).opponent_revealed_name is None


@pytest.mark.parametrize("source", ["opponent", "streamerHistory"])
def test_enriched_envelope_identity_is_preserved_through_raw_bridge_ticks(source):
    h = Harness().boot(); key = h.new_key(); event = envelope("match_loading", key)
    if source == "opponent":
        event["opponent"]["revealedName"] = "KnownPlayer"
    else:
        event["streamerHistory"] = {"oppName": OPP, "oppRevealedName": "KnownPlayer"}
    h.send(event)
    assert loading(h).title.endswith("(aka KnownPlayer)")
    h.send(envelope("match_loading", key))
    assert loading(h).title.endswith("(aka KnownPlayer)")


@pytest.mark.parametrize("history", [
    {"oppName": "Someone else", "oppRevealedName": "Wrong player"},
    {"oppName": OPP, "oppRevealedName": "Wrong player", "opponentIdentityMatched": False},
])
def test_enriched_envelope_ignores_stale_and_ambiguous_history(history):
    h = Harness().boot(); key = h.new_key(); event = envelope("match_loading", key)
    event["streamerHistory"] = history; h.send(event)
    assert loading(h).title == f"PvZ · vs {OPP}"


def test_alias_text_is_bounded_and_does_not_repeat_the_opponent_name():
    assert versus("Barcode", " KnownPlayer ") == "vs Barcode (aka KnownPlayer)"
    assert versus("Player", "player") == "vs Player"
    assert versus(None, "KnownPlayer") is None
    assert parse_scouting_brief(brief("key", name=["bad"]), "key").opponent_revealed_name is None
    assert parse_scouting_brief(brief("key", name="🦊" * 100), "key").opponent_revealed_name == "🦊" * 60
