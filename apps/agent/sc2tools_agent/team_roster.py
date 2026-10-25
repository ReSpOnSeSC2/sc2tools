from __future__ import annotations

from copy import deepcopy
import hashlib
import math
import time

from .live.types import _normalise_player_name, normalise_live_race


ACTIVE_PHASES = {"match_loading", "match_started", "match_in_progress"}
TEAM_FEATURES = {"opponentOverlay", "scoutingOverlay", "scoutingReadAloud"}


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def _team(value):
    return str(value) if type(value) is int and 0 <= value <= 16 else value if isinstance(value, str) and 0 < len(value) <= 32 else None


def _identity(row):
    player_id = row.get("player_id", row.get("id"))
    player_id = str(player_id) if type(player_id) is int and player_id >= 0 else ""
    value = "|".join((player_id, _normalise_player_name(row["name"])))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _stamp(envelope):
    stamp = envelope.get("receivedAt")
    return stamp / 1000 if type(stamp) in {int, float} else envelope.get("capturedAt")


def roster_candidate(snapshot, *, now=None):
    if not isinstance(snapshot, dict) or snapshot.get("paired") is not True:
        return None
    envelope = snapshot.get("liveGame")
    if (not isinstance(envelope, dict) or envelope.get("phase") not in ACTIVE_PHASES or envelope.get("isReplay") is not False
            or any(envelope.get(key) is True for key in ("isObserver", "is_observer", "sourceObserver", "sourceIsObserver", "source_is_observer"))):
        return None
    key = envelope.get("gameKey")
    players = envelope.get("players")
    stamp = _stamp(envelope)
    current = time.time() if now is None else now
    if (not isinstance(key, str) or not key or len(key) > 1000
            or type(stamp) not in {int, float} or not math.isfinite(stamp) or not -5 <= current - stamp <= 30
            or not isinstance(players, list) or not 3 <= len(players) <= 16):
        return None
    rows = []
    for source in players:
        if not isinstance(source, dict) or source.get("type") != "user" or source.get("isObserver") is True:
            return None
        name = _text(source.get("name"))
        if not name or len(name) > 120:
            return None
        row = {"name": name, "race": normalise_live_race(source.get("race")),
               "player_id": source.get("player_id", source.get("id")),
               "team": _team(source.get("team_id", source.get("teamId", source.get("team"))))}
        row["key"] = _identity(row)
        rows.append(row)
    if len({row["key"] for row in rows}) != len(rows):
        return None
    rows.sort(key=lambda row: row["key"])
    own = envelope.get("user") if isinstance(envelope.get("user"), dict) else {}
    own_name = _normalise_player_name(_text(own.get("name")))
    matched = [row for row in rows if own_name and _normalise_player_name(row["name"]) == own_name]
    return {"gameKey": key, "accountKey": snapshot.get("accountKey"), "players": rows,
            "ownKey": matched[0]["key"] if len(matched) == 1 else None,
            "elapsed": envelope.get("displayTime")}


class TeamRoster:
    def __init__(self):
        self.reset()

    def reset(self):
        self.candidate = None
        self.signature = None
        self.own_key = None
        self.enemy_keys = []
        self.selected_key = None
        self.confirmed = False
        self.bindings = {}
        self.manual_bindings = set()

    def update(self, snapshot, *, now=None):
        candidate = roster_candidate(snapshot, now=now)
        signature = (candidate["accountKey"], candidate["gameKey"], tuple((row["key"], row["team"]) for row in candidate["players"])) if candidate else None
        changed = signature != self.signature
        if changed:
            self.reset()
            self.signature = signature
        self.candidate = candidate
        if candidate and not self.confirmed:
            self.own_key = candidate["ownKey"]
            own = self.player(self.own_key)
            teams = {row["team"] for row in self.players}
            if own and own["team"] is not None and None not in teams and len(teams) == 2:
                enemies = [row["key"] for row in self.players if row["team"] != own["team"]]
                if any(row["key"] != own["key"] and row["team"] == own["team"] for row in self.players):
                    self.confirm(own["key"], enemies)
        return changed

    @property
    def players(self):
        return deepcopy(self.candidate["players"]) if self.candidate else []

    @property
    def enemies(self):
        return [row for row in self.players if row["key"] in self.enemy_keys] if self.confirmed else []

    @property
    def ready(self):
        return bool(self.candidate and self.confirmed and self.selected_key in self.enemy_keys)

    def player(self, key):
        return next((row for row in self.players if row["key"] == key), None)

    def confirm(self, own_key, enemy_keys):
        keys = {row["key"] for row in self.players}
        enemies = list(dict.fromkeys(enemy_keys)) if isinstance(enemy_keys, list) else []
        if (own_key not in keys or not enemies or own_key in enemies or not set(enemies) <= keys
                or not keys - set(enemies) - {own_key}):
            raise ValueError("Choose yourself, at least one teammate, and at least one enemy. Free-for-all is not team scouting.")
        self.own_key = own_key
        self.enemy_keys = enemies
        self.selected_key = self.selected_key if self.selected_key in enemies else enemies[0]
        self.bindings = {key: value for key, value in self.bindings.items() if key in enemies}
        self.manual_bindings.intersection_update(enemies)
        self.confirmed = True

    def select(self, key):
        if self.ready and key in self.enemy_keys:
            self.selected_key = key
            return True
        return False

    def step(self, direction):
        enemies = self.enemies
        if not self.ready or not enemies:
            return False
        keys = [row["key"] for row in enemies]
        return self.select(keys[(keys.index(self.selected_key) + direction) % len(keys)])

    def bind_directory(self, directory):
        available = {str(row.get("pulseId")): row for row in directory if isinstance(row, dict) and row.get("pulseId")}
        self.bindings = {key: value for key, value in self.bindings.items() if key in self.manual_bindings and value in available}
        self.manual_bindings.intersection_update(self.bindings)
        for enemy in self.enemies:
            if enemy["key"] in self.bindings:
                continue
            if sum(_normalise_player_name(row["name"]) == _normalise_player_name(enemy["name"]) and row["race"] == enemy["race"] for row in self.players) != 1:
                continue
            matches = [str(row["pulseId"]) for row in available.values()
                       if _normalise_player_name(_text(row.get("name") or row.get("displayName") or row.get("displayNameSample"))) == _normalise_player_name(enemy["name"])
                       and enemy["race"] is not None and normalise_live_race(row.get("race") or row.get("oppRaceModal")) == enemy["race"]]
            if len(matches) == 1:
                self.bindings[enemy["key"]] = matches[0]

    def bind(self, key, pulse_id, directory):
        valid = {str(row["pulseId"]) for row in directory if isinstance(row, dict) and row.get("pulseId")}
        if key not in self.enemy_keys or pulse_id not in valid:
            raise ValueError("Choose a replay identity from your own opponent library.")
        self.bindings[key] = pulse_id
        self.manual_bindings.add(key)

    def context(self, details=None):
        if not self.ready:
            return None
        enemy = self.player(self.selected_key)
        pulse_id = self.bindings.get(self.selected_key)
        detail = (details or {}).get(pulse_id, {}) if pulse_id else {}
        totals = detail.get("totals") if isinstance(detail.get("totals"), dict) else {}
        return {**deepcopy(detail), "name": enemy["name"], "revealedName": enemy["name"], "race": enemy["race"],
                "mmr": detail.get("mmr"), "mmrSource": "Historical 1v1 MMR · not team rating" if detail.get("mmr") is not None else "Team MMR unavailable",
                "headToHead": deepcopy(totals), "elapsed": self.candidate["elapsed"],
                "opponentIdentityMatched": bool(pulse_id and detail), "pulseId": pulse_id,
                "opponentNotes": {"text": detail.get("notes") or "", "readAloud": detail.get("notesReadAloud") is True},
                "teamHybrid": True, "teamEnemyKey": self.selected_key,
                "teamEnemies": self.enemies, "teamOwnPlayer": self.player(self.own_key)}
