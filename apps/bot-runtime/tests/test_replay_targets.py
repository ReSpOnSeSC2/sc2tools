from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace as NS

import pytest

from pluto_sc2 import replay_targets as targets
from pluto_sc2.replays import ReplayError


def event(kind, loop=0, tag=1, *, recycle=1, owner=1, name="Probe", **extra):
    value = {"_event": "NNet.Replay.Tracker." + kind, "_gameloop": loop,
             "m_unitTagIndex": tag, "m_unitTagRecycle": recycle, **extra}
    if kind in {"SUnitBornEvent", "SUnitInitEvent", "SUnitOwnerChangeEvent"}:
        value["m_upkeepPlayerId"] = owner
    if kind in {"SUnitBornEvent", "SUnitInitEvent", "SUnitTypeChangeEvent"}:
        value["m_unitTypeName"] = name.encode()
    return value


def start():
    return [event("SUnitBornEvent", tag=index) for index in range(1, 9)] + [
        event("SUnitBornEvent", tag=9, name="Nexus")]


def test_counts_only_completed_own_units_and_processes_full_boundary():
    events = start() + [event("SUnitBornEvent", 100, 40, owner=2, name="Stalker"),
                        event("SUnitInitEvent", 1344, 10, name="Gateway"),
                        event("SUnitBornEvent", 1344, 11, name="Probe"),
                        event("SUnitBornEvent", 1344, 12, name="Zealot"),
                        event("SUnitDoneEvent", 1400, 10)]
    frames = targets.frames_from_events(events, player_id=1, game_loops=2688)
    assert frames[0] == {"seconds": 0, "counts": {"NEXUS": 1, "PROBE": 8}}
    assert frames[1] == {"seconds": 60, "counts": {"NEXUS": 1, "PROBE": 9, "ZEALOT": 1}}
    assert frames[2]["counts"] == {"GATEWAY": 1, "NEXUS": 1, "PROBE": 9, "ZEALOT": 1}


def test_death_tag_recycle_morph_and_ownership_loss_are_not_extra_production():
    events = start() + [event("SUnitBornEvent", 20, 10, name="Gateway"),
                        event("SUnitTypeChangeEvent", 30, 10, name="WarpGate"),
                        event("SUnitBornEvent", 40, 11, name="Stalker"),
                        event("SUnitDiedEvent", 50, 11),
                        event("SUnitBornEvent", 60, 11, recycle=2, name="Stalker"),
                        event("SUnitDiedEvent", 70, 11),  # old recycle must not kill new unit
                        event("SUnitOwnerChangeEvent", 80, 1, owner=2),
                        event("SUnitOwnerChangeEvent", 90, 90, owner=1)]  # untracked acquisition omitted
    counts = targets.frames_from_events(events, player_id=1, game_loops=1344)[1]["counts"]
    assert counts == {"NEXUS": 1, "PROBE": 7, "STALKER": 1, "WARPGATE": 1}


def test_cancelled_construction_hallucinations_and_spell_objects_are_excluded():
    events = start() + [event("SUnitInitEvent", 10, 10, name="Gateway"),
                        event("SUnitDiedEvent", 20, 10),
                        event("SUnitBornEvent", 30, 11, name="Phoenix", m_creatorAbilityName=b"HallucinationPhoenix"),
                        event("SUnitBornEvent", 40, 12, name="AdeptPhaseShift"),
                        event("SUnitBornEvent", 50, 13, name="BeaconAttack")]
    counts = targets.frames_from_events(events, player_id=1, game_loops=1344)[1]["counts"]
    assert counts == {"NEXUS": 1, "PROBE": 8}


def test_no_future_or_opponent_state_enters_earlier_frames():
    base = start() + [event("SUnitBornEvent", 1500, 10, name="Colossus")]
    altered = start() + [event("SUnitBornEvent", 10, 900, owner=2, name="Colossus"),
                         event("SUnitTypeChangeEvent", 20, 900, name="Carrier"),
                         event("SUnitDiedEvent", 30, 900),
                         event("SUnitBornEvent", 1500, 10, name="Colossus")]
    expected = targets.frames_from_events(base, player_id=1, game_loops=2688)
    assert targets.frames_from_events(altered, player_id=1, game_loops=2688) == expected
    assert "COLOSSUS" not in expected[1]["counts"]
    assert expected[2]["counts"]["COLOSSUS"] == 1


def test_requires_eight_worker_start_and_ordered_events():
    with pytest.raises(ReplayError, match="eight"):
        targets.frames_from_events(start()[1:], player_id=1, game_loops=1344)
    with pytest.raises(ReplayError, match="ordered"):
        targets.frames_from_events(start() + [event("SUnitDiedEvent", 50), event("SUnitDiedEvent", 40)],
                                    player_id=1, game_loops=1344)


def trajectory(replay_id="a" * 64, matchup="PvT"):
    return {"replay_id": replay_id, "source_sha256": replay_id, "matchup": matchup,
            "result": "Victory", "starting_workers": 8, "frames": [
                {"seconds": 0, "counts": {"PROBE": 8, "NEXUS": 1}},
                {"seconds": 60, "counts": {"PROBE": 12, "NEXUS": 1, "GATEWAY": 1}},
                {"seconds": 120, "counts": {"PROBE": 16, "NEXUS": 1, "WARPGATE": 1, "STALKER": 2}}]}


def artifact():
    return {"version": targets.VERSION, "train_replay_ids": ["a" * 64, "b" * 64],
            "validation_replay_ids": ["c" * 64], "trajectories": [trajectory()]}


def test_frame_lookup_is_causal_and_clamped():
    ref = trajectory()
    assert targets.frame_at(ref, 59.99)["seconds"] == 0
    assert targets.frame_at(ref, 60)["seconds"] == 60
    assert targets.frame_at(ref, 900)["seconds"] == 120
    with pytest.raises(ValueError):
        targets.frame_at(ref, float("nan"))


def test_similarity_is_bounded_composition_specific_and_alias_aware():
    goal = {"PROBE": 16, "NEXUS": 1, "GATEWAY": 2, "STALKER": 4}
    assert targets.replay_similarity(goal, goal) == 1
    assert targets.replay_similarity({}, goal) == 0
    assert targets.replay_similarity({name: 10 * count for name, count in goal.items()}, goal) == 1
    assert targets.replay_similarity({**goal, "STALKER": 0, "ZEALOT": 100}, goal) == pytest.approx(.55)
    assert targets.replay_similarity({"PROBE": 16, "NEXUS": 1, "WARPGATE": 2, "STALKER": 4}, goal) == 1
    assert targets.replay_similarity({"PROBE": 100}, {}) == 0
    with pytest.raises(ValueError):
        targets.replay_similarity({"PROBE": -1}, goal)


@pytest.mark.parametrize("mutation", [
    lambda data: data["train_replay_ids"].append("c" * 64),
    lambda data: data["trajectories"][0].update(replay_id="c" * 64, source_sha256="c" * 64),
    lambda data: data["trajectories"][0].update(result="Defeat"),
    lambda data: data["trajectories"][0].update(source_sha256="d" * 64),
    lambda data: data["trajectories"][0]["frames"][0]["counts"].update(PROBE=12),
    lambda data: data["trajectories"][0]["frames"][1].update(seconds=0),
])
def test_artifact_rejects_split_contamination_loss_and_provenance_failures(mutation):
    data = artifact()
    mutation(data)
    with pytest.raises((ReplayError, ValueError)):
        targets.validate_targets(data)


def test_selection_is_reproducible_matchup_specific_and_returns_independent_copy():
    data = artifact()
    data["trajectories"].append(trajectory("b" * 64, "PvZ"))
    first = targets.select_trajectory(data, "PvZ", 123)
    assert first == targets.select_trajectory(data, "PvZ", 123)
    assert first["replay_id"] == "b" * 64
    first["frames"][0]["counts"]["PROBE"] = 100
    assert data["trajectories"][1]["frames"][0]["counts"]["PROBE"] == 8
    with pytest.raises(ReplayError, match="No winning"):
        targets.select_trajectory(data, "PvP", 123)


def test_builder_only_decodes_winning_training_replays_and_preserves_sources(tmp_path, monkeypatch):
    manifest_path, metrics_path = tmp_path / "manifest.json", tmp_path / "metrics.json"
    manifest = {"complete": True, "player_name": "ReSpOnSe", "replays": [
        {"replay_id": "a" * 64, "result": "Victory", "matchup": "PvT", "starting_workers": 8},
        {"replay_id": "b" * 64, "result": "Defeat", "matchup": "PvT", "starting_workers": 8},
        {"replay_id": "c" * 64, "result": "Victory", "matchup": "PvT", "starting_workers": 8}]}
    metrics = {key: value for key, value in artifact().items() if key.endswith("replay_ids")}
    manifest_path.write_text(json.dumps(manifest))
    metrics_path.write_text(json.dumps(metrics))
    before = [path.read_bytes() for path in (manifest_path, metrics_path)]
    decoded = []

    def extract(record, *, player_name):
        decoded.append((record["replay_id"], player_name))
        return trajectory(record["replay_id"])

    monkeypatch.setattr(targets, "extract_trajectory", extract)
    output = tmp_path / "new-targets.json"
    result = targets.build_targets(manifest_path, metrics_path, output)
    assert decoded == [("a" * 64, "ReSpOnSe")]
    assert result["excluded_loss_replay_ids"] == ["b" * 64]
    assert targets.load_targets(output) == result
    assert before == [path.read_bytes() for path in (manifest_path, metrics_path)]
    with pytest.raises(FileExistsError):
        targets.build_targets(manifest_path, metrics_path, output)
    metrics["validation_replay_ids"].append("a" * 64)
    metrics_path.write_text(json.dumps(metrics))
    with pytest.raises(ReplayError, match="disjoint"):
        targets.build_targets(manifest_path, metrics_path)


def test_extraction_checks_archive_player_result_and_source_hash(tmp_path, monkeypatch):
    import mpyq

    path = tmp_path / "sample.SC2Replay"
    path.write_bytes(b"synthetic test source")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    record = {"path": str(path), "sha256": digest, "replay_id": digest, "player_id": 1, "matchup": "PvT"}
    info = {"replay_id": digest, "game_speed": "Faster", "game_loops": 1344, "players": [
        {"player_id": 1, "name": "ReSpOnSe", "race": "Protoss", "result": "Win", "starting_workers": 8},
        {"player_id": 2, "name": "Opponent", "race": "Terran", "result": "Loss", "starting_workers": 8}]}
    monkeypatch.setattr(targets, "inspect_replay", lambda _: deepcopy(info))
    monkeypatch.setattr(mpyq, "MPQArchive", lambda _: NS(read_file=lambda _: b"events"))
    monkeypatch.setattr(targets, "_metadata_protocol", lambda: NS(decode_replay_tracker_events=lambda _: iter(start())))
    result = targets.extract_trajectory(record, player_name="ReSpOnSe")
    assert result["source_sha256"] == digest
    assert result["frames"][1]["counts"] == {"NEXUS": 1, "PROBE": 8}
    info["players"][0]["result"] = "Loss"
    with pytest.raises(ReplayError, match="victory"):
        targets.extract_trajectory(record, player_name="ReSpOnSe")
    info["players"][0]["result"] = "Win"
    path.write_bytes(b"changed")
    with pytest.raises(ReplayError, match="SHA256"):
        targets.extract_trajectory(record, player_name="ReSpOnSe")
