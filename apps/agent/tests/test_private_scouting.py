from datetime import datetime, timezone

import pytest

from sc2tools_agent.build_checkin.scouting import (
    parse_scouting_brief, plain_text, scouting_model,
)

NOW = datetime(2026, 10, 23, 12, tzinfo=timezone.utc).timestamp()


def payload():
    return {
        "gameKey": "current", "oppName": "Opponent", "pulseId": "1-S2-1-42",
        "h2h": {"w": 3, "l": 2},
        "lastMet": {"at": "2026-10-21T12:00:00Z", "result": "Loss", "map": "Alcyone"},
        "forecast": {"name": "12 Pool", "share": 0.6, "samples": 3, "n": 5},
        "bestAnswer": {"build": "Hatch First", "w": 3, "l": 1},
        "note": "Private note", "dossierUrl": "https://malicious.invalid/",
    }


def test_full_scouting_renders_the_actual_record_opening_and_private_note():
    brief = parse_scouting_brief(payload(), "current")
    model = scouting_model(brief, NOW)
    assert model.record_line == "You 3–2 · last met 2 days ago (L on Alcyone)"
    assert model.opening_line == "Usually: 12 Pool (3 of last 5) · Best: Hatch First 3–1"
    assert model.note == "Private note"
    assert model.dossier_path == "/app/opponents/1-S2-1-42"


def test_shared_posterior_keeps_prior_only_low_confidence_and_aliases_honest():
    raw = payload()
    raw["forecast"] = {"method": "posterior", "name": "Hatch First", "share": .6, "samples": 0, "n": 0, "effectiveN": 0, "confidence": "Low"}
    raw["alsoPlaysAs"] = ["Alt", "Alt", "Another", "not displayed"]
    model = scouting_model(parse_scouting_brief(raw, "current"), NOW)
    assert "Forecast: Hatch First (60% · Low confidence · effective n=0.0)" in model.opening_line
    assert "0 of last 0" not in model.opening_line
    assert model.record_line.endswith("also: Alt, Another")


@pytest.mark.parametrize("patch", [{"effectiveN": float("nan")}, {"share": True}, {"confidence": "Certain"}, {"effectiveN": 76}, {"n": 51}])
def test_invalid_posterior_cannot_fall_back_to_a_confident_opening(patch):
    raw = payload()
    raw["forecast"].update(method="posterior", confidence="Low", effectiveN=2.4)
    raw["forecast"].update(patch)
    assert not parse_scouting_brief(raw, "current").opening


def test_first_meeting_and_unknown_are_distinct_without_invented_tendencies():
    raw = {"gameKey": "current", "oppName": "New opponent", "h2h": {"w": 0, "l": 0}}
    model = scouting_model(parse_scouting_brief(raw, "current"), NOW)
    assert model.record_line == "First meeting"
    assert model.opening_line == "Opening history not available"
    assert not model.note
    assert model.dossier_path == "/app/opponents"
    raw.pop("h2h")
    assert scouting_model(parse_scouting_brief(raw, "current"), NOW).record_line == "No confirmed record yet"
    assert parse_scouting_brief(None, "current") is None


def test_previous_game_and_invalid_identity_are_ignored():
    assert parse_scouting_brief(payload(), "new-game") is None
    assert parse_scouting_brief({**payload(), "oppName": []}, "current") is None
    assert parse_scouting_brief({**payload(), "gameKey": None}, None) is None


@pytest.mark.parametrize("bad", [None, [], "bad", True, -1, float("inf")])
def test_malformed_fields_cannot_crash_or_invent_a_record(bad):
    raw = payload()
    raw.update(h2h={"w": bad, "l": 2}, forecast={"samples": bad, "n": 5}, bestAnswer=bad)
    raw["lastMet"] = {"result": bad, "at": bad, "map": bad}
    brief = parse_scouting_brief(raw, "current")
    assert brief.record is None
    assert not brief.opening
    assert scouting_model(brief, NOW).record_line == "No confirmed record yet"


def test_note_matches_utf16_api_limit_and_user_markup_stays_plain_data():
    raw = payload(); raw["note"] = "🦊" * 300
    brief = parse_scouting_brief(raw, "current")
    assert len(brief.note.encode("utf-16-le")) == 1000
    assert plain_text("<b>private</b>", 500) == "<b>private</b>"


def test_timezone_offsets_and_future_dates_never_make_negative_age():
    raw = payload(); raw["lastMet"]["at"] = "2026-10-21T14:00:00+02:00"
    brief = parse_scouting_brief(raw, "current")
    assert brief.last_met_at == NOW - 2 * 86_400
    assert "last met today" in scouting_model(brief, NOW - 3 * 86_400).record_line


@pytest.mark.parametrize("identity", ["https://bad.invalid", "../other", "1-S2-1-42?redirect=x", "1-S2-1-42/elsewhere"])
def test_dossier_target_comes_only_from_validated_toon_identity(identity):
    raw = payload(); raw["pulseId"] = identity
    brief = parse_scouting_brief(raw, "current")
    assert brief.pulse_id is None
    assert brief.dossier_path == "/app/opponents"
