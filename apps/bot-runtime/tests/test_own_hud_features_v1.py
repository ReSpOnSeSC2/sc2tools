"""Synthetic boundary fixtures are tests only, never admitted replay data."""
from copy import deepcopy
import math

import numpy as np
import pytest

from pluto_sc2 import own_hud_features_v1 as hud
from scripts import extract_own_hud_features_v1 as extractor


def event(loop, player=2, minerals=50, gas=0, used=8 * 4096):
    return {"_event": "NNet.Replay.Tracker.SPlayerStatsEvent", "_gameloop": loop,
            "m_playerId": player, "m_stats": {"m_scoreValueMineralsCurrent": minerals,
            "m_scoreValueVespeneCurrent": gas, "m_scoreValueFoodUsed": used,
            "m_scoreValueFoodMade": 999999999, "opponent_score": 1}}


def sequence():
    return {"replay_id": "a" * 64, "player_id": 2, "race": "Protoss", "partition": "train",
            "events": [{"ordinal": 4, "game_loop": 5, "token": "1:0"},
                       {"ordinal": 9, "game_loop": 20, "token": "2:0"},
                       {"ordinal": 10, "game_loop": 20, "token": "3:0"},
                       {"ordinal": 12, "game_loop": 30, "token": "4:0"}]}


def index(events, race="Protoss"):
    return hud.index_own_stats(events, player_id=2, race=race)


def test_strict_sample_before_anchor_and_same_loop_target_siblings():
    stats = index([event(1, minerals=15), event(5, minerals=70), event(19, minerals=100), event(20, minerals=500)])
    first = hud.make_sidecar(sequence(), 1, stats)
    sibling = hud.make_sidecar(sequence(), 2, stats)
    last = hud.make_sidecar(sequence(), 3, stats)
    assert first["features"] == sibling["features"]
    assert first["features"]["minerals"] == 15  # sample5 == anchor5 is excluded
    assert first["binding"]["previous_own_macro_anchor_source_event_index"] == 4
    assert sibling["binding"]["previous_own_macro_anchor_command_sha256"] == hud.canonical_sha(sequence()["events"][0])
    assert last["features"]["minerals"] == 100  # sample20 == anchor20 excluded
    assert last["binding"]["previous_own_macro_anchor_source_event_index"] == 10
    assert last["features"]["age_seconds"] == 1 / 22.4


def test_future_and_opponent_mutations_cannot_change_earlier_features():
    base = index([event(1), event(2, player=1, minerals=999)])
    changed = index([event(1), event(2, player=1, minerals=0), event(100, minerals=900)])
    seq = sequence()
    a = hud.make_sidecar(seq, 1, base)
    seq["events"].append({"ordinal": 20, "game_loop": 200, "token": "future"})
    b = hud.make_sidecar(seq, 1, changed)
    assert a == b


def test_no_anchor_and_no_past_sample_are_missing_not_backfilled():
    stats = index([event(5), event(20)])
    first = hud.make_sidecar(sequence(), 0, stats)
    second = hud.make_sidecar(sequence(), 1, stats)
    assert first["missing_reason"] == "no_strictly_previous_own_macro_command"
    assert second["missing_reason"] == "no_own_stats_strictly_before_anchor"
    assert np.array_equal(hud.encode_actor_features(first), np.zeros(8, dtype=np.float32))
    assert np.array_equal(hud.encode_actor_features(second), np.zeros(8, dtype=np.float32))


def test_duplicate_stats_must_agree_and_conflicts_do_not_backfill():
    same = index([event(1), event(1)])
    assert same[0]["duplicate_count"] == 2 and not same[0]["ambiguous"]
    changed = index([event(0, minerals=10), event(1, minerals=50), event(1, minerals=51)])
    row = hud.make_sidecar(sequence(), 1, changed)
    assert row["missing_reason"] == "ambiguous_same_loop_own_stats"
    assert row["binding"]["sample_loop"] == 1
    assert row["features"]["minerals"] is None
    assert not hud.encode_actor_features(row).any()


def test_ignored_fields_do_not_change_duplicate_equality():
    one, two = event(1), event(1)
    two["m_stats"]["m_scoreValueFoodMade"] = -100
    two["m_stats"]["opponent_score"] = 100000
    assert not index([one, two])[0]["ambiguous"]
    assert "supply_made" not in str(index([one]))


@pytest.mark.parametrize("invalid", [-1, None, True, 1.5, float("nan")])
def test_invalid_latest_fields_are_missing_without_clamp(invalid):
    stats = index([event(0), event(1, minerals=invalid)])
    # NaN is deliberately rejected even at canonical provenance serialization.
    if isinstance(invalid, float) and math.isnan(invalid):
        with pytest.raises(ValueError):
            hud.make_sidecar(sequence(), 1, stats)
    else:
        row = hud.make_sidecar(sequence(), 1, stats)
        assert row["missing_reason"] == "invalid_latest_own_stats"
        assert not hud.encode_actor_features(row).any()


def test_protoss_fractional_supply_scale_and_other_race_no_unproven_supply():
    row = hud.make_sidecar(sequence(), 1, index([event(1, minerals=8000, used=216 * 4096 + 2048)]))
    assert row["features"]["supply_used"] == 216.5  # no clamp to200
    encoded = hud.encode_actor_features(row)
    assert encoded.dtype == np.float32 and encoded.shape == (8,)
    assert encoded[0] > 1 and encoded[2] > 1
    other = sequence()
    other["race"] = "Zerg"
    row = hud.make_sidecar(other, 1, index([event(1, used=-50)], race="Zerg"))
    assert row["features"]["bank_known"]
    assert row["features"]["supply_used"] is None
    assert not row["features"]["supply_used_known"]


def test_encoder_excludes_target_time_ordinal_and_outcome_metadata():
    row = hud.make_sidecar(sequence(), 1, index([event(1)]))
    before = hud.encode_actor_features(row)
    row["binding"] = {"target_game_loop": 999999, "target_source_event_index": 123456}
    row["outcome"] = "Win"
    np.testing.assert_array_equal(hud.encode_actor_features(row), before)
    row["features"]["target_game_loop"] = 99
    with pytest.raises(ValueError, match="allowlist"):
        hud.encode_actor_features(row)


def test_encoder_unknown_value_must_be_null_and_all_missing_age_zero():
    row = hud.make_sidecar(sequence(), 0, [])
    row["features"]["age_seconds"] = 1
    with pytest.raises(ValueError, match="age/missingness"):
        hud.encode_actor_features(row)
    row["features"]["age_seconds"] = None
    row["features"]["minerals"] = 50
    with pytest.raises(ValueError, match="value/missingness"):
        hud.encode_actor_features(row)


def test_cross_player_stats_rejected_and_out_of_order_tracker_rejected():
    with pytest.raises(ValueError, match="own-player"):
        hud.project_stats(event(1, player=1), player_id=2, race="Protoss")
    with pytest.raises(ValueError, match="ordered"):
        index([event(2), event(1)])
    stats = index([event(1)])
    stats[0]["player_id"] = 1
    with pytest.raises(ValueError, match="Cross-player"):
        hud.make_sidecar(sequence(), 1, stats)


@pytest.mark.parametrize("change", ["ordinal", "loop", "duplicate"])
def test_original_command_order_identity_guard(change):
    seq = sequence()
    if change == "ordinal":
        seq["events"][3]["ordinal"] = 8  # rising loop cannot conceal backward global ordinal
    elif change == "loop":
        seq["events"][3]["game_loop"] = 3
    else:
        seq["events"][3]["ordinal"] = 10
    with pytest.raises(ValueError, match="identity/order"):
        hud.validate_commands(seq)


def test_empty_metadata_view_has_no_fabricated_target():
    seq = sequence()
    seq["events"] = []
    hud.validate_commands(seq)
    with pytest.raises(ValueError):
        hud.previous_anchor(seq["events"], 0)


@pytest.mark.parametrize("change", ["anchor", "target", "sample_equal", "owner", "age", "partition"])
def test_sidecar_binding_guard(change):
    row = hud.make_sidecar(sequence(), 1, index([event(1)]))
    hud.validate_sidecar_binding(row, sequence(), 1)
    if change == "anchor":
        row["binding"]["previous_own_macro_anchor_source_event_index"] = 1
    elif change == "target":
        row["binding"]["target_command_sha256"] = "0" * 64
    elif change == "sample_equal":
        row["binding"]["sample_loop"] = 5
    elif change == "owner":
        row["binding"]["sample_player_id"] = 1
    elif change == "age":
        row["features"]["age_seconds"] = (20 - 1) / 22.4  # forbidden target-based age
    else:
        row["partition_metadata"] = "validation"
    with pytest.raises(ValueError):
        hud.validate_sidecar_binding(row, sequence(), 1)


def test_extraction_budget_and_stop_are_bounded(tmp_path):
    clock = [0]
    marker = tmp_path / "STOP"
    budget = extractor.Budget(2, [marker], monotonic=lambda: clock[0])
    budget.check()
    clock[0] = 2
    with pytest.raises(TimeoutError):
        budget.check()
    marker.write_text("respect existing marker")
    with pytest.raises(InterruptedError):
        budget.check()
    assert marker.read_text() == "respect existing marker"
    for bad in (0, -1, 601, float("inf"), float("nan")):
        with pytest.raises(ValueError):
            extractor.Budget(bad, [])


def test_output_is_fresh_and_input_hash_checked(tmp_path):
    output = extractor.create_output(tmp_path / "new")
    with pytest.raises(FileExistsError):
        extractor.create_output(output)
    original = tmp_path / "original.SC2Replay"
    original.write_bytes(b"original archive fixture")
    expected = extractor.digest(original.read_bytes())
    extractor.pin_bytes(original, expected)
    original.write_bytes(b"changed")
    with pytest.raises(ValueError, match="Pinned input changed"):
        extractor.pin_bytes(original, expected)
    assert not extractor.unchanged({str(original): expected})


def test_same_setup_input_cannot_silently_repin_changed_content(tmp_path):
    path = tmp_path / "pin"
    path.write_bytes(b"first")
    pins = {}
    extractor.add_pin(pins, path)
    path.write_bytes(b"second")
    with pytest.raises(ValueError, match="during setup"):
        extractor.add_pin(pins, path)


def test_archive_identity_uses_verified_clan_normalization_and_exact_race():
    header = {"m_version": {"m_baseBuild": 97563}, "m_elapsedGameLoops": 100}
    details = {"m_gameSpeed": 4, "m_playerList": [{"m_name": b"Enemy", "m_race": b"Terran"},
               {"m_name": b"&lt;TGosuP&gt;<sp/>ReSpOnSe", "m_race": b"Protoss"}]}
    views = [{"player_id": 2, "race": "Protoss", "player_name": "ReSpOnSe", "game_loops": 100}]
    extractor.validate_archive(header, details, views)
    for field, wrong in (("race", "Terran"), ("player_name", "Different"), ("game_loops", 99)):
        bad = deepcopy(views)
        bad[0][field] = wrong
        with pytest.raises(ValueError, match="identity/race/duration"):
            extractor.validate_archive(header, details, bad)


def test_partial_receipt_cannot_load_as_training_data(tmp_path):
    (tmp_path / "result.json").write_text('{"schema":"own-hud-sidecar-extraction-v1","status":"stopped_at_bound"}')
    with pytest.raises(ValueError, match="incomplete"):
        hud.load_hud_sidecar(tmp_path, dataset=tmp_path)


def test_source_hash_failure_prevents_output_creation(tmp_path):
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    (dataset / "result.json").write_text("{}")
    output = tmp_path / "output"
    with pytest.raises(ValueError, match="Pinned input changed"):
        extractor.extract(output=output, dataset=dataset)
    assert not output.exists()


def test_existing_stop_prevents_read_or_output_creation(tmp_path):
    marker = tmp_path / "STOP"
    marker.write_text("user stop")
    with pytest.raises(InterruptedError):
        extractor.extract(output=tmp_path / "output", dataset=tmp_path / "nonexistent")
    assert not (tmp_path / "output").exists()
