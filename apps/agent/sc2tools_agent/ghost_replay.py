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
    if not 2 <= len(players) <= 16:
        raise GhostError("Choose a replay with two to sixteen players.")
    manual_only = len(players) != 2
    choices = []
    for player in players:
        if getattr(player, "is_human", True) is False or getattr(player, "is_ai", False) is True:
            continue
        opponent = next(other for other in players if other is not player)
        mine = concrete_race(getattr(player, "play_race", None))
        theirs = concrete_race(getattr(opponent, "play_race", None)) if not manual_only else None
        if not mine or not manual_only and not theirs:
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
        matchup = mine + "v" + theirs if not manual_only else None
        target = normalize_target({"v": 1, "name": f"{matchup or mine + ' · team replay'} · {name}"[:80],
                                   "sourceGameId": source_id + ":" + str(player.pid),
                                   "steps": steps})
        if target:
            choices.append({"id": str(player.pid), "name": name, "race": mine,
                            "opponentRace": theirs, "matchup": matchup, "manualOnly": manual_only,
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
