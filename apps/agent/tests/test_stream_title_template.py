"""Local-only rendering: tests prohibit all network/provider operations."""
import pytest

from sc2tools_agent.streaming.title_template import render_title, title_values, validate_template


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Title rendering must not use a network or provider.")
    monkeypatch.setattr("socket.socket.connect", forbidden)
    monkeypatch.setattr("requests.request", forbidden)


STATS = {"mmr": 5321, "league": "Grandmaster", "session": {"wins": 3, "losses": 2},
         "streak": {"kind": "win", "count": 2}, "peak": 5600,
         "winRates": {"PvZ": {"wins": 5, "losses": 3}, "TvP": {"wins": 0, "losses": 2}}}


def test_all_supported_tokens_render_truthfully_without_side_effects():
    assert render_title("{mmr} {league} {record} {wins}/{losses} {streak} {peak} {wr:PvZ}", STATS) == (
        "5321 Grandmaster 3W–2L 3/2 W2 5600 63%")
    assert title_values(STATS)["wr:TvP"] == "0%"


def test_missing_stats_drop_the_whole_optional_segment_without_inventing_zero():
    assert render_title("SC2 grind | {mmr} MMR | {record} today | {wr:PvZ} PvZ", {}) == "SC2 grind"
    assert title_values({}) == {}
    assert render_title("{mmr} MMR | StarCraft II", {}) == "StarCraft II"
    with pytest.raises(ValueError, match="stats are unavailable"):
        render_title("{mmr} MMR", {})


def test_known_zero_record_is_different_from_unavailable_record():
    assert render_title("{record}", {"session": {"wins": 0, "losses": 0}}) == "0W–0L"
    assert "wr:PvZ" not in title_values({"winRates": {"PvZ": {"wins": 0, "losses": 0}}})


def test_optional_segments_are_dropped_in_order_without_cutting_a_word():
    required = "A" * 60
    assert render_title(required + " | {mmr} | Final whole segment", STATS) == required + " | 5321"
    assert render_title("A" * 70 + " | {record}", STATS) == "A" * 70
    with pytest.raises(ValueError, match="1–70"):
        render_title("A" * 71, STATS)


def test_unicode_survives_rendering_and_unchanged_inputs_are_deterministic():
    template = "🎮 별Craft | {record} | {mmr} MMR"
    expected = "🎮 별Craft | 3W–2L | 5321 MMR"
    assert render_title(template, STATS) == expected
    assert render_title(template, dict(reversed(list(STATS.items())))) == expected


@pytest.mark.parametrize("template", ["{unknown}", "{wr:PvQ}", "{wr:pvz}", "{mmr", "mmr}", "{{mmr}}", "<title>", "x\ny", "x\ty", "", " " * 2, "X" * 501])
def test_invalid_templates_are_rejected_before_provider_validation(template):
    with pytest.raises(ValueError):
        validate_template(template)


@pytest.mark.parametrize("stats", [None, [], {"league": []}, {"mmr": True}, {"mmr": -1},
                                   {"mmr": float("nan")}, {"mmr": float("inf")},
                                   {"league": "<fake>"}, {"peak": 10000},
                                   {"session": {"wins": -1, "losses": 1}},
                                   {"streak": {"kind": "win", "count": 0}},
                                   {"winRates": {"PvZ": {"wins": True, "losses": 1}}}])
def test_malformed_unavailable_values_never_enter_a_title(stats):
    assert render_title("SC2 | {mmr} | {league} | {peak} | {record} | {streak} | {wr:PvZ}", stats) == "SC2"


MATCH = {"gameKey": "current-game", "opponent": "Barcode", "alias": "Maru", "map": "Alcyone LE",
         "race": "Protoss", "h2h": {"wins": 3, "losses": 2}}


def test_current_opponent_alias_map_and_head_to_head_are_separate_from_session_stats():
    stats = {**STATS, "currentMatch": MATCH}
    assert render_title("GM {race} v {opp} {aka} | {h2h} | {map} | {h2h_wr}", stats) == (
        "GM Protoss v Barcode (aka Maru) | 3W–2L | Alcyone LE | 60%")
    values = title_values(stats)
    assert values["record"] == "3W–2L" and values["h2h"] == "3W–2L"
    assert values["wr:PvZ"] == "63%" and values["h2h_wr"] == "60%"


def test_known_match_without_an_alias_leaves_no_empty_parentheses_or_extra_spaces():
    for alias in (None, "", "barcode"):
        assert render_title("SC2 v {opp} {aka} on {map}", {"currentMatch": {**MATCH, "alias": alias}}) == (
            "SC2 v Barcode on Alcyone LE")


def test_missing_match_and_unknown_history_do_not_fabricate_opponent_or_win_rate():
    assert render_title("SC2 | v {opp} {aka} | {h2h} | {map}", {}) == "SC2"
    unknown = {key: value for key, value in MATCH.items() if key != "h2h"}
    assert "h2h" not in title_values({"currentMatch": unknown})
    first = {"currentMatch": {**MATCH, "h2h": {"wins": 0, "losses": 0}}}
    assert render_title("v {opp} | {h2h} | {h2h_wr}", first) == "v Barcode | 0W–0L"


@pytest.mark.parametrize("match", [None, [], {}, {**MATCH, "gameKey": ""}, {**MATCH, "opponent": []},
    {**MATCH, "opponent": "<Player>"}, {**MATCH, "opponent": "Player\nOther"}])
def test_invalid_match_identity_cannot_supply_any_match_tokens(match):
    assert render_title("SC2 | {opp} {aka} | {map} | {h2h}", {"currentMatch": match}) == "SC2"


@pytest.mark.parametrize("field,value", [("alias", ["Maru"]), ("alias", "<Maru>"),
    ("map", "Private\nMap"), ("race", "FakeRace"), ("h2h", {"wins": True, "losses": 2}),
    ("h2h", {"wins": -1, "losses": 2})])
def test_malformed_match_fields_are_omitted_without_losing_valid_opponent(field, value):
    values = title_values({"currentMatch": {**MATCH, field: value}})
    assert values["opp"] == "Barcode"
    for token in {"alias": ["aka"], "map": ["map"], "race": ["race"], "h2h": ["h2h", "h2h_wr"]}[field]:
        assert token not in values


def test_optional_match_details_drop_whole_segments_at_the_title_limit():
    stats = {"currentMatch": {**MATCH, "map": "Map with a very long and descriptive tournament edition name"}}
    assert render_title("GM Protoss v {opp} {aka} | {h2h} | {map}", stats) == (
        "GM Protoss v Barcode (aka Maru) | 3W–2L")


def test_game_start_settings_are_independent_owner_bound_and_legacy_compatible():
    from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
    current = load_title_settings({}, "owner")
    assert current["on_game_start"] is False
    payload = {"enabled": False, "on_game_start": True, "template": "SC2 v {opp}",
               "platforms": {"twitch": True, "kick": True, "youtube": False}}
    configured = configure_title_settings(current, payload, "owner")
    assert configured["enabled"] is False and configured["on_game_start"] is True
    assert load_title_settings(configured, "owner")["on_game_start"] is True
    assert load_title_settings(configured, "other-owner")["on_game_start"] is False
    legacy = {key: value for key, value in payload.items() if key != "on_game_start"}
    assert configure_title_settings(configured, legacy, "owner")["on_game_start"] is True
    configured["last_start_game"] = "current-game"
    assert load_title_settings(configured, "owner")["last_start_game"] == "current-game"
    assert load_title_settings(configured, "other-owner")["last_start_game"] == ""
    assert configure_title_settings(configured, legacy, "owner")["last_start_game"] == "current-game"


@pytest.mark.parametrize("post_sync_enabled", [False, True])
def test_upgrading_legacy_settings_never_enables_game_start_posting(post_sync_enabled):
    from sc2tools_agent.streaming.title_settings import load_title_settings
    settings = load_title_settings({"owner": "owner", "enabled": post_sync_enabled,
        "template": "SC2 | {record}"}, "owner")
    assert settings["enabled"] is post_sync_enabled
    assert settings["on_game_start"] is False


@pytest.mark.parametrize("receipt", [None, [], "", "   ", "x" * 301, "old\ngame", "old\x7fgame"])
def test_malformed_start_receipts_are_not_restored(receipt):
    from sc2tools_agent.streaming.title_settings import load_title_settings
    assert load_title_settings({"owner": "owner", "last_start_game": receipt}, "owner")["last_start_game"] == ""


@pytest.mark.parametrize("on_game_start", [1, "true", None])
def test_game_start_opt_in_requires_an_actual_boolean(on_game_start):
    from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
    with pytest.raises(ValueError, match="start of each game"):
        configure_title_settings(load_title_settings({}, "owner"), {"enabled": False,
            "on_game_start": on_game_start, "template": "SC2", "platforms": {"twitch": True, "kick": True, "youtube": False}}, "owner")


def test_game_start_opt_in_requires_pairing_and_a_selected_platform():
    from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
    payload = {"enabled": False, "on_game_start": True, "template": "SC2",
               "platforms": {"twitch": False, "kick": False, "youtube": False}}
    with pytest.raises(ValueError, match="Pair this agent"):
        configure_title_settings(load_title_settings({}, ""), payload, "")
    with pytest.raises(ValueError, match="Choose at least one"):
        configure_title_settings(load_title_settings({}, "owner"), payload, "owner")


@pytest.mark.parametrize("draft", ["", "{unknown}", "<invalid>", None])
def test_both_title_switches_can_be_disabled_with_an_invalid_draft(draft):
    from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
    current = load_title_settings({"owner": "owner", "enabled": True,
        "on_game_start": True, "template": "Saved prefix | v {opp}"}, "owner")
    configured = configure_title_settings(current, {"enabled": False, "on_game_start": False,
        "template": draft, "platforms": {"twitch": True, "kick": True, "youtube": False}}, "owner")
    assert configured["enabled"] is False and configured["on_game_start"] is False
    assert configured["template"] == "Saved prefix | v {opp}"
    assert load_title_settings(configured, "owner")["on_game_start"] is False


def test_disabling_without_a_valid_saved_template_keeps_it_empty():
    from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
    configured = configure_title_settings(load_title_settings({}, "owner"), {
        "enabled": False, "on_game_start": False, "template": "",
        "platforms": {"twitch": False, "kick": False, "youtube": False}}, "owner")
    assert configured["template"] == ""
    assert configured["enabled"] is False and configured["on_game_start"] is False


@pytest.mark.parametrize("enabled,on_game_start", [(True, False), (False, True), (True, True)])
def test_an_invalid_draft_still_rejects_either_automatic_option(enabled, on_game_start):
    from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
    current = load_title_settings({"owner": "owner", "template": "Saved prefix"}, "owner")
    with pytest.raises(ValueError, match="Unknown title token"):
        configure_title_settings(current, {"enabled": enabled, "on_game_start": on_game_start,
            "template": "{unknown}", "platforms": {"twitch": True, "kick": True, "youtube": False}}, "owner")
