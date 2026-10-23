"""Read a user-selected local replay without importing or uploading it."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path

from .companion_ghost import GhostError, MAX_GHOST_STEPS, concrete_race, normalize_target


MAX_REPLAY_BYTES = 64 * 1024 * 1024


def targets_from_replay(replay, source_id, source_label):
    from core.event_extractor import extract_events

    players = [player for player in getattr(replay, "players", [])
               if not getattr(player, "is_observer", False)]
    if len(players) != 2:
        raise GhostError("Choose a one-versus-one replay with two players.")
    choices = []
    for player, opponent in (players, list(reversed(players))):
        mine = concrete_race(getattr(player, "play_race", None))
        theirs = concrete_race(getattr(opponent, "play_race", None))
        if not mine or not theirs:
            continue
        events, _, _ = extract_events(replay, player.pid)
        steps = []
        for event in sorted(events, key=lambda row: row.get("time", 0)):
            kind, stamp = event.get("type"), event.get("time")
            if (kind not in {"building", "unit", "upgrade"}
                    or type(stamp) not in {int, float}
                    or not math.isfinite(stamp) or not 0 < stamp <= 14400):
                continue
            started = kind == "building" and event.get("subtype") in {"init", "born"}
            steps.append({"name": event.get("name"), "t": stamp, "kind": kind,
                          "timing": "started" if started else "completed", "supply": None})
            if len(steps) == MAX_GHOST_STEPS:
                break
        name = str(getattr(player, "name", "Player"))[:64]
        target = normalize_target({"v": 1, "name": f"{mine}v{theirs} · {name}"[:80],
                                   "sourceGameId": source_id + ":" + str(player.pid),
                                   "steps": steps})
        if target:
            choices.append({"id": str(player.pid), "name": name, "race": mine,
                            "opponentRace": theirs, "matchup": mine + "v" + theirs,
                            "target": target})
    if not choices:
        raise GhostError("This replay has no supported timed build steps. Try another replay.")
    return {"players": choices, "sourceLabel": source_label}


def load_local_ghost_replay(file_path):
    if not isinstance(file_path, str) or not file_path or len(file_path) > 32767:
        raise GhostError("Choose a local .SC2Replay file.")
    path = Path(file_path).expanduser()
    try:
        if path.suffix.lower() != ".sc2replay" or not path.is_file():
            raise GhostError("Choose an existing .SC2Replay file.")
        size = path.stat().st_size
        if not 0 < size <= MAX_REPLAY_BYTES:
            raise GhostError("Choose a replay smaller than 64 MB.")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        from .replay_pipeline import bootstrap_analyzer_path

        bootstrap_analyzer_path()
        import sc2reader

        replay = sc2reader.load_replay(str(path), load_level=4)
        return targets_from_replay(replay, "local:" + digest.hexdigest(), path.name)
    except GhostError:
        raise
    except Exception as exc:
        raise GhostError("Could not read that replay. Check it opens in StarCraft II, then try again.") from exc
