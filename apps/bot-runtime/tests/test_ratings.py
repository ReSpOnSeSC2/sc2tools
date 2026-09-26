"""Rating examples are fixtures, not evidence of this bot's playing strength."""

from dataclasses import replace
from datetime import datetime, timezone
import json

import pytest

from pluto_sc2.ratings import MatchEvidence, RatingAssessment, benchmark_status, load_evidence, save_evidence


POLICY = "a" * 64
NOW = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)


def human(**changes):
    fields = dict(match_id="human-1", policy_sha256=POLICY, played_at="2026-09-23T12:00:00Z",
                  opponent_kind="human", result="win", region="US", source_url="https://example.org/matches/1",
                  verified_by="Named benchmark adjudicator", opponent_mmr=6200, rating_system="Battle.net 1v1")
    fields.update(changes)
    return MatchEvidence(**fields)


def assessment(**changes):
    fields = dict(assessment_id="external-1", policy_sha256=POLICY, as_of="2026-09-24T00:00:00Z",
                  kind="external_estimate", mmr=6100, region="US",
                  method="Externally supplied calibration report; its statistical method is not validated here.",
                  source_url="https://example.org/calibration/1", verified_by="Named benchmark adjudicator",
                  match_ids=("human-1",), lower_bound=5800, upper_bound=6400)
    fields.update(changes)
    return RatingAssessment(**fields)


def status(matches=(), report=None, **changes):
    return benchmark_status(policy_sha256=POLICY, matches=matches, assessment=report, now=NOW, region="US", **changes)


def test_empty_benchmark_is_unrated_with_requested_target():
    report = benchmark_status(policy_sha256=POLICY, now=NOW)
    assert report["status"] == report["target_progress"] == "unrated"
    assert report["target_mmr"] == 6000
    assert report["measured_mmr"] is report["external_estimated_mmr"] is None
    assert report["region"] is None


def test_any_number_of_ai_or_selfplay_wins_never_becomes_mmr():
    matches = [MatchEvidence(str(index), POLICY, "2026-09-23T12:00:00Z", opponent, "win", region="US")
               for index in range(100) for opponent in ("built_in_ai",)]
    matches += [MatchEvidence("self-" + str(index), POLICY, "2026-09-23T12:00:00Z", "self_play", "win") for index in range(100)]
    report = status(matches)
    assert report["status"] == "unrated"
    assert report["current_attested_rated_human_matches"] == 0
    assert report["recorded_matches_by_opponent_kind"] == {"built_in_ai": 100, "self_play": 100}
    assert report["measured_mmr"] is report["external_estimated_mmr"] is None


def test_wins_over_rated_humans_without_assessment_do_not_estimate_own_rating():
    report = status([human(match_id=str(index), opponent_mmr=7000) for index in range(50)])
    assert report["current_attested_rated_human_matches"] == 50
    assert report["status"] == "unrated"
    assert report["measured_mmr"] is report["external_estimated_mmr"] is None
    assert report["statistical_sufficiency"] == "not_assessed"


def test_external_estimate_stays_separate_from_official_mmr_and_preserves_interval():
    report = status([human()], assessment())
    assert report["status"] == "external_estimate_reported"
    assert report["measured_mmr"] is None
    assert report["external_estimated_mmr"] == 6100
    assert report["reported_interval"] == [5800, 6400]
    assert report["target_progress"] == "reported_interval_crosses_target"
    assert report["assessment"]["verified_by"] == "Named benchmark adjudicator"
    assert report["statistical_sufficiency"] == "not_assessed"


def test_official_rating_requires_official_source_and_is_labeled_reported():
    record = assessment(kind="official_ladder", source_url="https://starcraft2.blizzard.com/fixture/ladder",
                        lower_bound=None, upper_bound=None)
    report = status([human()], record)
    assert report["status"] == "official_rating_reported"
    assert report["measured_mmr"] == 6100
    assert report["external_estimated_mmr"] is None
    assert report["target_progress"] == "reported_at_or_above_target"
    with pytest.raises(ValueError, match="official ladder"):
        assessment(kind="official_ladder", source_url="https://blizzard.com.evil.example/fixture")


@pytest.mark.parametrize("changes", [
    {"policy_sha256": "b" * 64}, {"region": "EU"},
    {"as_of": "2026-07-01T00:00:00Z"}, {"as_of": "2026-10-01T00:00:00Z"},
    {"as_of": "2026-09-23T00:00:00Z"}, {"match_ids": ("absent-match",)},
])
def test_stale_mismatched_future_or_unsupported_assessments_cannot_claim_progress(changes):
    report = status([human()], assessment(**changes))
    assert report["status"] == report["target_progress"] == "unrated"
    assert report["measured_mmr"] is report["external_estimated_mmr"] is None
    assert report["assessment"] is None
    assert report["reasons"]


@pytest.mark.parametrize("changes", [
    {"verified_by": None}, {"source_url": None}, {"opponent_mmr": None}, {"rating_system": None},
    {"policy_sha256": "b" * 64}, {"region": "EU"}, {"played_at": "2026-07-01T00:00:00Z"},
    {"opponent_kind": "built_in_ai", "opponent_mmr": None},
    {"opponent_kind": "self_play", "opponent_mmr": None},
])
def test_assessment_cannot_launder_unqualified_match_evidence(changes):
    report = status([human(**changes)], assessment())
    assert report["status"] == "unrated"
    assert report["current_attested_rated_human_matches"] == 0


def test_benchmark_without_region_cannot_inherit_an_assessment_region():
    report = benchmark_status(policy_sha256=POLICY, matches=[human()], assessment=assessment(), now=NOW)
    assert report["status"] == "unrated"


@pytest.mark.parametrize("make_record", [
    lambda: human(played_at="2026-09-24"),
    lambda: human(policy_sha256="unknown"),
    lambda: human(opponent_kind="built_in_ai"),
    lambda: human(source_url="https://user:secret@example.org/record"),
    lambda: assessment(mmr=float("nan")),
    lambda: assessment(method=""),
    lambda: assessment(match_ids=()),
    lambda: assessment(match_ids=("one", "one")),
    lambda: assessment(lower_bound=6200, upper_bound=6400),
    lambda: assessment(lower_bound=None),
])
def test_malformed_evidence_is_rejected(make_record):
    with pytest.raises(ValueError):
        make_record()


def test_json_roundtrip_preserves_external_provenance_and_rejects_duplicate_ids(tmp_path):
    path = tmp_path / "evidence.json"
    matches, reports = [human()], [assessment()]
    save_evidence(path, matches, reports)
    loaded = load_evidence(path)
    assert loaded == {"matches": matches, "assessments": reports}
    assert status(loaded["matches"], loaded["assessments"][0]) == status(matches, reports[0])
    with pytest.raises(ValueError, match="duplicate"):
        save_evidence(path, [human(), human(result="loss")])
    payload = json.loads(path.read_text())
    payload["matches"].append(payload["matches"][0])
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="duplicate"):
        load_evidence(path)


def test_failed_atomic_evidence_save_preserves_existing_records(tmp_path, monkeypatch):
    from pluto_sc2 import ratings

    path = tmp_path / "evidence.json"
    save_evidence(path, [human()])
    original = path.read_bytes()

    def fail_replace(*args):
        raise OSError("simulated full disk")

    monkeypatch.setattr(ratings.os, "replace", fail_replace)
    with pytest.raises(OSError, match="full disk"):
        save_evidence(path, [replace(human(), result="loss")])
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]
