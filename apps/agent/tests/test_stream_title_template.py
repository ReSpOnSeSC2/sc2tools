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
