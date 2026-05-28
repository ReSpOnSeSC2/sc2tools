import json

db = {
    "fake_build": {
        "wins": 1,
        "losses": 0,
        "games": [
            {
                "date": "2024-01-01T12:00:00Z",
                "map": "Equilibrium LE",
                "opponent": "FakeOpponent",
                "result": "Victory",
                "file_path": "reveal-sc2-opponent-main/data/sample_fake_replay.SC2Replay",
                "me_name": "Jules",
                "opp_race": "Zerg",
                "id": "fake_game_123"
            }
        ]
    }
}
with open("reveal-sc2-opponent-main/data/meta_database.json", "w") as f:
    json.dump(db, f)
