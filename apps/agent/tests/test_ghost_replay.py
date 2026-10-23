from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent.companion_ghost import GhostError
from sc2tools_agent.ghost_replay import load_local_ghost_replay, targets_from_replay


def test_local_targets_offer_both_players_and_keep_recorded_timing(monkeypatch):
    extractor = Mock(return_value=([
        {"type": "worker", "time": 1, "name": "Probe"},
        {"type": "building", "subtype": "born", "time": 0, "name": "Nexus"},
        {"type": "building", "subtype": "init", "time": 43, "name": "Gateway"},
        {"type": "unit", "time": 120, "name": "Adept"},
        {"type": "upgrade", "time": 155, "name": "WarpGateResearch"},
    ], [], {}))
    import sys

    monkeypatch.setitem(sys.modules, "core.event_extractor", SimpleNamespace(extract_events=extractor))
    replay = SimpleNamespace(players=[
        SimpleNamespace(pid=1, name="Sample P", play_race="Protoss"),
        SimpleNamespace(pid=2, name="Sample T", play_race="Terran"),
    ])
    result = targets_from_replay(replay, "local:hash", "Example.SC2Replay")
    assert [choice["matchup"] for choice in result["players"]] == ["PvT", "TvP"]
    steps = result["players"][0]["target"]["steps"]
    assert [(step["t"], step["timing"]) for step in steps] == [
        (43, "started"), (120, "completed"), (155, "completed")]
    assert result["players"][1]["target"]["sourceGameId"] == "local:hash:2"


@pytest.mark.parametrize("filename", ["missing.SC2Replay", "not-replay.txt"])
def test_local_picker_rejects_missing_or_non_replay(tmp_path, filename):
    if filename.endswith("txt"):
        (tmp_path / filename).write_text("not a replay")
    with pytest.raises(GhostError, match="existing .SC2Replay"):
        load_local_ghost_replay(str(tmp_path / filename))


def test_local_picker_rejects_empty_replay(tmp_path):
    path = tmp_path / "empty.SC2Replay"
    path.touch()
    with pytest.raises(GhostError, match="64 MB"):
        load_local_ghost_replay(str(path))


def test_zerg_born_structure_is_construction_start_but_morph_is_completion(monkeypatch):
    import sys

    def events(_replay, player_id):
        return ([
            {"type": "building", "subtype": "born", "time": 0, "name": "Hatchery"},
            {"type": "building", "subtype": "born", "time": 43, "name": "Hatchery"},
            {"type": "building", "subtype": "morph", "time": 254, "name": "Lair"},
        ] if player_id == 1 else [
            {"type": "building", "subtype": "init", "time": 50, "name": "Gateway"},
        ], [], {})

    monkeypatch.setitem(sys.modules, "core.event_extractor", SimpleNamespace(extract_events=events))
    replay = SimpleNamespace(players=[
        SimpleNamespace(pid=1, name="Zerg player", play_race="Zerg"),
        SimpleNamespace(pid=2, name="Protoss player", play_race="Protoss"),
    ])
    result = targets_from_replay(replay, "local:hash", "Example.SC2Replay")
    assert result["players"][0]["matchup"] == "ZvP"
    assert [(step["name"], step["t"], step["timing"]) for step in result["players"][0]["target"]["steps"]] == [
        ("Hatchery", 43, "started"), ("Lair", 254, "completed"),
    ]
