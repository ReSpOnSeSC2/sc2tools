"""Bounded local desktop history and deterministic game/session summaries."""
from __future__ import annotations

import copy
from datetime import datetime, timezone, timedelta
import json
import math
from pathlib import Path
import threading

from .state import _replace_state_file

MAX_RECENT_GAMES = 200
RETRYABLE_SKIPS = frozenset({"player_unresolved", "parse_failed", "file_unstable", "filtered"})
SKIP_REASONS = {
    "player_unresolved": ("We couldn't tell which player was you", "Set player name, then retry"),
    "parse_failed": ("This replay could not be analyzed", "Check the file, then retry"),
    "file_unstable": ("StarCraft II was still saving this replay", "Wait for the file to finish, then retry"),
    "filtered": ("Outside your selected sync range", "Review the sync filter, then retry"),
    "ai_game": ("A game against the computer", "Only supported player matches are synced"),
    "resumed_replay": ("A replay resumed with Take Command", "Synthetic results are excluded from records"),
    "no_result": ("No final game result was recorded", "A completed match is needed"),
    "unsupported_replay": ("This replay format isn't supported", "Check for an agent update"),
}
RACES = {"Protoss", "Terran", "Zerg", "Random"}
REGIONS = {"1": "NA", "2": "EU", "3": "KR", "5": "CN", "6": "SEA"}


def parse_time(raw):
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    except ValueError:
        return None


def _integer(raw, low=0, high=9999):
    return (int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool)
            and math.isfinite(raw) and low <= raw <= high and int(raw) == raw else None)


def build_game_summary(game, accepted, *, history=False):
    """Whitelist CloudGame metadata; accepted canonical gameId wins on rename."""
    accepted = accepted if isinstance(accepted, dict) else {}
    opponent = getattr(game, "opponent", None)
    opponent = opponent if isinstance(opponent, dict) else {}
    identifier = accepted.get("gameId") or getattr(game, "game_id", None)
    date = getattr(game, "date_iso", None)
    raw_result = str(getattr(game, "result", "")).casefold()
    result = {"victory": "Victory", "win": "Victory", "defeat": "Defeat", "loss": "Defeat", "tie": "Tie"}.get(raw_result)
    own_race, opp_race = getattr(game, "my_race", None), opponent.get("race")
    handle = getattr(game, "my_toon_handle", None)
    region = REGIONS.get(handle.split("-", 1)[0]) if isinstance(handle, str) else None
    name = opponent.get("displayName") or opponent.get("name")
    return {
        "gameId": identifier[:2048] if isinstance(identifier, str) and identifier else None,
        "dateIso": date if parse_time(date) else None,
        "result": result,
        "races": {"own": own_race if own_race in RACES else None,
                  "opponent": opp_race if opp_race in RACES else None},
        "oppName": name[:256] if isinstance(name, str) else None,
        "map": str(getattr(game, "map_name", ""))[:256] or None,
        "durationSec": _integer(getattr(game, "duration_sec", None), high=24 * 3600),
        "mmr": _integer(getattr(game, "my_mmr", None), low=500),
        "isLadder": getattr(game, "is_ladder_game", None) if type(getattr(game, "is_ladder_game", None)) is bool else None,
        "region": region,
        "ladderRace": getattr(game, "my_ladder_race", None) or own_race,
        "isHistory": bool(history), "isResumed": getattr(game, "is_resumed_from_replay", False) is True,
    }


def today_summary(rows, *, now=None):
    """Played-today record; MMR deltas never cross an unknown/other ladder."""
    now = now or datetime.now().astimezone()
    local_zone = now.tzinfo or datetime.now().astimezone().tzinfo
    dated = [(parse_time(row.get("dateIso")), row) for row in rows
             if row.get("status") == "uploaded" and not row.get("isResumed")]
    played = sorted(((date, row) for date, row in dated if date and date.astimezone(local_zone).date() == now.date()
                     and date <= now), key=lambda pair: (pair[0], str(pair[1].get("gameId"))))
    wins = sum(row.get("result") == "Victory" for _, row in played)
    losses = sum(row.get("result") == "Defeat" for _, row in played)
    net = 0
    pairs = 0
    previous = None
    for _, row in played:
        mmr = _integer(row.get("mmr"), low=500)
        ladder = (row.get("region"), row.get("ladderRace"))
        if row.get("isLadder") is not True or mmr is None or not all(ladder):
            previous = None
            continue
        if previous and previous[0] == ladder:
            net += mmr - previous[1]
            pairs += 1
        previous = (ladder, mmr)
    return {"wins": wins, "losses": losses, "games": len(played),
            "netMmr": net if pairs else None, "mmrPairs": pairs,
            "lastGame": copy.deepcopy(played[-1][1]) if played else None}


def upload_facts(uploaded, rows=(), *, now=None):
    """Cursor uploads are upload-time stats; game record uses played-time stats."""
    now = now or datetime.now().astimezone()
    dates = [value for raw in uploaded.values() if (value := parse_time(raw)) is not None and value <= now]
    return {
        "synced": len(dates),
        "syncedToday": sum(value.astimezone(now.tzinfo).date() == now.date() for value in dates),
        "lastUploadAt": max(dates).isoformat() if dates else None,
        "failed24h": sum(row.get("status") == "problem" and (at := parse_time(row.get("updatedAt"))) is not None
                         and now - timedelta(hours=24) <= at <= now for row in rows),
    }


def skipped_groups(uploaded):
    grouped = {}
    for path, marker in uploaded.items():
        if marker == "filtered":
            reason = "filtered"
        elif isinstance(marker, str) and marker.startswith("skipped:"):
            reason = marker[len("skipped:"):]
        else:
            continue
        grouped.setdefault(reason, []).append(path)
    return [{"reason": reason, "count": len(paths), "paths": paths,
             "title": SKIP_REASONS.get(reason, ("This replay was skipped", "Open the activity log"))[0],
             "action": SKIP_REASONS.get(reason, ("", "Open the activity log"))[1],
             "retryable": reason in RETRYABLE_SKIPS} for reason, paths in sorted(grouped.items())]


class RecentGamesStore:
    """Per-account view of 200 local rows. All disk calls belong off Qt."""
    def __init__(self, state_dir, *, owner=None, uploaded=None, paths_by_id=None):
        self.path = Path(state_dir) / "recent_games.jsonl"
        self.owner = owner
        self.lock = threading.RLock()
        self.rows = []
        existed = self.path.exists()
        if existed:
            try:
                with self.path.open(encoding="utf-8") as stream:
                    for line in stream:
                        try:
                            row = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(row, dict) and row.get("owner") == owner:
                            self.rows.append(row)
                            self.rows = self.rows[-MAX_RECENT_GAMES:]
            except OSError:
                pass
        elif owner:
            reverse = {path: game_id for game_id, path in (paths_by_id or {}).items()}
            seeds = sorted(((at, path) for path, raw in (uploaded or {}).items()
                            if (at := parse_time(raw)) is not None), reverse=True)[:100]
            for at, path in reversed(seeds):
                self.rows.append({"owner": owner, "path": path, "updatedAt": at.isoformat(),
                                  "gameId": reverse.get(path), "status": "uploaded", "seeded": True})
            self._save()

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(list(reversed(self.rows)))

    def record(self, path, summary, *, status="uploaded", detail=None, now=None):
        now = now or datetime.now(timezone.utc)
        row = {**summary, "owner": self.owner, "path": str(path), "status": status,
               "updatedAt": now.isoformat()}
        if detail:
            row["error"] = str(detail)[:2000]
        with self.lock:
            before = self.rows
            self.rows = [old for old in self.rows if old.get("path") != row["path"]
                         and not (row.get("gameId") and old.get("gameId") == row["gameId"])]
            self.rows.append(row)
            self.rows = self.rows[-MAX_RECENT_GAMES:]
            try:
                self._save()
            except OSError:
                self.rows = before
                raise
        return copy.deepcopy(row)

    def _save(self):
        # Same-directory durable replacement keeps a crash from truncating the
        # required JSONL file. The writer is called off the Qt thread.
        import os
        import tempfile
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix="recent-games-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                for row in self.rows:
                    stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            # Reuse the state writer's bounded Windows sharing-violation
            # retry; antivirus/indexer reads can briefly hold this file too.
            _replace_state_file(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
