from copy import deepcopy

from scripts.verify_own_hud_sidecar_v1 import independent_index, independent_row


def event(loop, *, player=1, minerals=50, gas=0, supply=32768, made=32768):
    return {"_gameloop": loop, "_event": "NNet.Replay.Tracker.SPlayerStatsEvent", "m_playerId": player,
            "m_stats": {"m_scoreValueMineralsCurrent": minerals, "m_scoreValueVespeneCurrent": gas,
                        "m_scoreValueFoodUsed": supply, "m_scoreValueFoodMade": made}}


def sequence():
    return {"replay_id": "real-identity-fixture-only", "player_id": 1, "race": "Protoss", "partition": "train",
            "events": [{"game_loop": loop, "ordinal": ordinal} for loop, ordinal in ((10, 4), (20, 8), (20, 9))]}


def test_future_and_opponent_stats_cannot_change_strict_same_loop_features():
    own = independent_index([event(1), event(10, minerals=1000), event(15, minerals=2000)], 1, "Protoss")
    left = independent_row(sequence(), 1, own)
    right = independent_row(sequence(), 2, own)
    assert left["features"] == right["features"]
    assert left["features"]["minerals"] == 50
    assert left["binding"]["sample_loop"] == 1
    assert left["binding"]["previous_own_macro_anchor_source_event_index"] == 4
    changed = independent_index([event(1), event(2, player=2, minerals=9999), event(10, minerals=1000),
                                 event(15, minerals=2000), event(99, minerals=9999)], 1, "Protoss")
    assert independent_row(sequence(), 2, changed) == right
    later_target = deepcopy(sequence())
    later_target["events"][1]["game_loop"] = 200
    assert independent_row(later_target, 1, own)["features"] == left["features"]


def test_ambiguous_latest_sample_stays_missing_without_backfill():
    samples = independent_index([event(0, minerals=40), event(1), event(1, minerals=51)], 1, "Protoss")
    row = independent_row(sequence(), 1, samples)
    assert row["missing_reason"] == "ambiguous_same_loop_own_stats"
    assert row["features"]["minerals"] is None and not row["features"]["bank_known"]
    assert row["binding"]["sample_duplicate_count"] == 2
    assert row["binding"]["sample_loop"] == 1


def test_excluded_foodmade_and_unverified_other_race_supply_never_project():
    samples = independent_index([event(1, made=0), event(1, made=99999999)], 1, "Protoss")
    assert not samples[0]["ambiguous"] and samples[0]["duplicate_count"] == 2
    assert independent_row(sequence(), 1, samples)["features"]["supply_used"] == 8
    terran = {**sequence(), "race": "Terran"}
    other = independent_index([event(1, supply=-999)], 1, "Terran")
    row = independent_row(terran, 1, other)
    assert row["features"]["bank_known"] and row["features"]["supply_used"] is None
    assert not row["features"]["supply_used_known"]
