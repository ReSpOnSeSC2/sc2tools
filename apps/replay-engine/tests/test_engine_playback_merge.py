"""Perspective-safe enrichment preserves tracker attribution and spell tags."""
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.sc2_observation_export import merge_precomputed_engine_playback, ARTIFACT_VERSION


def _artifact(tmp_path, my_pid=1):
    path = tmp_path / "example.SC2Replay"
    path.write_bytes(b"replay fixture identity")
    data = {"artifactVersion": ARTIFACT_VERSION, "myPid": my_pid, "myName": "&lt;TAG&gt;<sp/>Player",
            "replaySha256": hashlib.sha256(path.read_bytes()).hexdigest(), "playback": {
                "fidelity": {"positions": "engine", "paths": "observed", "creep": "observed", "attacks": "observed", "complete": True},
                "my_units": [{"id": str((1 << 32) + 123), "name": "LurkerMP", "born": 0,
                              "died": 10.2, "waypoints": [0, 20, 30],
                              "attacks": [6.2345, 8.7654], "aim": [6.2345, 25, 35],
                              "forms": [{"t": 5, "name": "BroodLordCocoon"}]}],
                "opp_units": [], "my_buildings": [], "opp_buildings": [],
            }}
    path.with_name(path.name + ".observations.json").write_text(json.dumps(data), encoding="utf-8")
    return path


def test_engine_merge_maps_tracker_tags_and_spent_deaths(tmp_path, monkeypatch):
    monkeypatch.delenv("SC2TOOLS_OBSERVATION_DIR", raising=False)
    path = _artifact(tmp_path)
    playback = {"me_pid": 1, "me_name": "Player", "my_units": [
        {"id": 123, "name": "Drone", "born": 0, "died": 10.05, "killer_pid": None}],
        "ability_casts": [{"casterUnitId": 123, "targetUnitId": 123, "casterUnitIds": [123]}]}
    result = merge_precomputed_engine_playback(playback, path, "Player")
    unit = result["my_units"][0]
    assert unit["name"] == "Lurker"
    assert unit["forms"][0]["name"] == "BroodLordCocoon"
    assert unit["died"] == 10.05 and unit["killer_pid"] is None
    assert unit["attacks"] == [6.2345, 8.7654]
    assert unit["aim"] == [6.2345, 25, 35]
    assert result["fidelity"]["attacks"] == "observed"
    assert result["ability_casts"] == [{"casterUnitId": str((1 << 32) + 123),
                                        "targetUnitId": str((1 << 32) + 123),
                                        "casterUnitIds": [str((1 << 32) + 123)]}]


def test_engine_merge_rejects_other_perspective_and_substring_names(tmp_path, monkeypatch):
    monkeypatch.delenv("SC2TOOLS_OBSERVATION_DIR", raising=False)
    path = _artifact(tmp_path, my_pid=2)
    playback = {"me_pid": 1, "me_name": "Player"}
    assert merge_precomputed_engine_playback(playback, path, "Player") is playback
    similar_name = {"me_name": "Play"}
    assert merge_precomputed_engine_playback(similar_name, path, "Play") is similar_name
    matching_name = {"me_name": "Player"}
    assert merge_precomputed_engine_playback(matching_name, path, "Player")["fidelity"]["positions"] == "engine"
