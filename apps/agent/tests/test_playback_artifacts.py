import copy
import hashlib
import json
from types import SimpleNamespace

import pytest

from sc2tools_agent.playback_artifacts import build_bundle, has_engine_playback, slice_playback
from sc2tools_agent.replay_pipeline import _compact_map_playback


def playback():
    return {"map_name": "Test", "game_length": 120, "replaySha256": "a" * 64,
            "bounds": {"x_min": 0, "y_min": 0, "x_max": 100, "y_max": 100},
            "fidelity": {"positions": "engine", "complete": True, "paths": "observed",
                         "creep": "observed", "attacks": "observed", "effects": "observed", "sampleSeconds": .1786},
            "my_units": [{"id": 1, "name": "Stalker", "born": 0, "died": 90,
                          "waypoints": [[t, 10 + t / 10, 10] for t in range(91)],
                          "attacks": [30, 59, 60, 90], "aim": [30, 11, 12, 90, 12, 12], "killer_pid": 2}],
            "opp_units": [{"id": 2, "name": "Marine", "born": 0, "died": 20,
                           "waypoints": [[0, 3, 3], [20, 5, 5]], "killer_pid": 1}],
            "my_buildings": [], "opp_buildings": [],
            "ability_casts": [{"owner": "me", "ability": "Blink", "t": 60}],
            "creep": {"width": 2, "height": 2, "frames": [{"t": 0, "runs": [0, 1]}, {"t": 59, "runs": [1, 1]}, {"t": 70, "runs": [2, 1]}]},
            "effects": [{"id": 1, "name": "Storm", "owner": "me", "t": 59, "end": 61, "x": 20, "y": 20, "radius": 1}]}


def test_slice_preserves_boundary_anchors_and_lifetime_skeletons():
    p = playback()
    old = copy.deepcopy(p)
    window = slice_playback(p, 60, 120)
    assert window["my_units"][0]["waypoints"][0][0] == 59
    assert window["opp_units"][0]["waypoints"] == [[0, 3, 3]]
    assert window["opp_units"][0]["died"] == 20
    assert window["creep"]["frames"][0]["t"] == 59
    assert window["effects"] == p["effects"]
    assert window["my_units"][0]["attacks"] == [60, 90]
    assert p == old


def test_bundle_roundtrip_bounded_complete_and_event_lossless(tmp_path):
    p = playback()
    manifest_path = build_bundle(p, tmp_path, source_sha256="b" * 64)
    manifest = json.loads(manifest_path.read_bytes())
    all_shots, all_casts = [], []
    for d in manifest["segments"]:
        body = (tmp_path / f"{d['sha256']}.json").read_bytes()
        assert len(body) == d["sizeBytes"] < 2 * 1024 * 1024
        assert hashlib.sha256(body).hexdigest() == d["sha256"]
        payload = json.loads(body)["playback"]
        assert payload["v"] == 7 and payload["terminalAttackInclusive"]
        assert payload["fidelity"]["complete"]
        assert payload["fidelity"]["positionError"] <= .5
        assert len(payload["units"]) == 2
        all_shots.extend(payload["units"][0]["attacks"])
        all_casts.extend(payload["casts"])
    assert all_shots == [30, 59, 60, 90]
    assert len(all_casts) == 1
    assert has_engine_playback(SimpleNamespace(playback_artifact_path=str(manifest_path)))
    assert build_bundle(p, tmp_path, source_sha256="b" * 64) == manifest_path


def test_legacy_terminal_attack_semantics_unchanged():
    p = playback()
    legacy = _compact_map_playback(p)
    assert legacy["v"] == 6 and legacy["fidelity"]["complete"] is False
    assert legacy["units"][0]["attacks"] == [30, 59, 60]


def test_v7_terminal_attack_uses_declared_millisecond_precision(tmp_path):
    p = playback()
    p["my_units"][0].update(died=90.571, attacks=[90.5714], aim=[])
    path = build_bundle(p, tmp_path, source_sha256="b" * 64)
    segments = json.loads(path.read_bytes())["segments"]
    last = json.loads((tmp_path / (segments[-1]["sha256"] + ".json")).read_bytes())
    assert last["playback"]["units"][0]["attacks"] == [90.571]
    p["my_units"][0]["attacks"] = [90.572]
    with pytest.raises(ValueError, match="Incomplete"):
        build_bundle(p, tmp_path, source_sha256="b" * 64)


def test_corrupt_existing_chunk_is_preserved_and_rejected(tmp_path):
    path = build_bundle(playback(), tmp_path, source_sha256="b" * 64)
    d = json.loads(path.read_bytes())["segments"][0]
    chunk = tmp_path / f"{d['sha256']}.json"
    chunk.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="digest"):
        build_bundle(playback(), tmp_path, source_sha256="b" * 64)
    assert chunk.read_bytes() == b"corrupt"


def test_upload_verifies_publication_and_raw_byte_identity(tmp_path, monkeypatch):
    from sc2tools_agent.api_client import ApiClient
    path = build_bundle(playback(), tmp_path, source_sha256="b" * 64)
    client = ApiClient("http://localhost", "test-token")
    calls = []
    def request(_self, method, url, **kwargs):
        calls.append((method, url, kwargs))
        if method == "PUT":
            return {"sha256": hashlib.sha256(kwargs["raw_body"]).hexdigest()}
        if url.endswith("complete"):
            return {"artifactId": "c" * 64, "segmentCount": 2}
        return {"artifactId": "c" * 64}
    monkeypatch.setattr(ApiClient, "_request", request)
    result = client.upload_playback_artifact("id/with slash", path)
    assert result["segmentCount"] == 2
    assert "%2F" in calls[0][1]
    assert [call[0] for call in calls] == ["POST", "PUT", "PUT", "POST"]
    assert all(len(call[2]["raw_body"]) < 2 * 1024 * 1024 for call in calls if call[0] == "PUT")


def test_incomplete_capture_cannot_publish(tmp_path):
    p = playback()
    p["fidelity"]["complete"] = False
    with pytest.raises(ValueError):
        build_bundle(p, tmp_path, source_sha256="b" * 64)


def test_reduced_legacy_fast_path_never_promotes_incomplete_artifact(tmp_path):
    fidelity = {**playback()["fidelity"], "complete": False}
    game = SimpleNamespace(map_playback={"fidelity": fidelity})
    assert not has_engine_playback(game)
    assert has_engine_playback(game, allow_reduced_legacy=True)
    assert game.map_playback["fidelity"]["complete"] is False
    bad_manifest = tmp_path / "incomplete.json"
    bad_manifest.write_text(json.dumps({"schema": "sc2tools-playback-manifest-v1", "fidelity": fidelity, "segments": [{}]}))
    game.playback_artifact_path = str(bad_manifest)
    assert not has_engine_playback(game, allow_reduced_legacy=True)
