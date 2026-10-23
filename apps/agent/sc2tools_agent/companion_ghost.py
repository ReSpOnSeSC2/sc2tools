"""Local exact-matchup Ghost targets sourced from the owner's replay library."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import math
import re
import threading
import time
from urllib.parse import quote


MATCHUPS = tuple(mine + "v" + theirs for mine in "PTZ" for theirs in "PTZ")
MAX_GHOST_STEPS = 250
MAX_GHOST_SECONDS = 14400
WORKERS = {"probe", "scv", "drone", "mule"}


class GhostError(ValueError):
    """A bounded, user-readable Ghost configuration error."""


def concrete_race(value):
    if not isinstance(value, str):
        return None
    return {"p": "P", "protoss": "P", "t": "T", "terran": "T",
            "z": "Z", "zerg": "Z"}.get(value.strip().lower())


def supports_ghost_game(game):
    if not isinstance(game, dict):
        return False
    match_format = game.get("matchFormat")
    count = game.get("playerCount")
    return (not isinstance(match_format, str) or match_format.lower() == "1v1") and (type(count) not in {int, float} or count == 2)


def _number(value, maximum=MAX_GHOST_SECONDS):
    return type(value) in {int, float} and 0 <= value <= maximum and math.isfinite(value)


def _text(value, limit):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f\u200b-\u200f\u2028\u2029]", "", value)).strip()[:limit]


def normalize_target(value):
    if not isinstance(value, dict) or type(value.get("v")) is not int or value["v"] != 1:
        return None
    name = _text(value.get("name"), 80)
    source_id = value.get("sourceGameId")
    source_steps = value.get("steps")
    if (not name or not isinstance(source_id, str) or not source_id
            or len(source_id) > 128 or re.search(r"[\x00-\x1f\x7f]", source_id)
            or not isinstance(source_steps, list) or not 0 < len(source_steps) <= MAX_GHOST_STEPS):
        return None
    steps = []
    for row in source_steps:
        if not isinstance(row, dict) or not _number(row.get("t")):
            return None
        entity = _text(row.get("name"), 64)
        kind = row.get("kind", "other")
        supply = row.get("supply")
        if (not entity or not isinstance(kind, str) or kind not in {"building", "unit", "upgrade", "other"}
                or supply is not None and not _number(supply, 200)):
            return None
        timing = row.get("timing", "started")
        if timing not in ("started", "completed", "recorded"):
            return None
        step = {"t": row["t"], "name": entity, "kind": kind,
                "timing": timing, "supply": int(supply) if supply is not None else None}
        completion = row.get("completeTime")
        if completion is not None:
            if not _number(completion) or completion < row["t"]:
                return None
            step["completeTime"] = completion
        steps.append(step)
    steps.sort(key=lambda row: row["t"])
    perspective = value.get("perspective")
    if perspective is not None and perspective not in ("you", "opponent"):
        return None
    return {"v": 1, "name": name, "sourceGameId": source_id, "steps": steps,
            **({"perspective": perspective} if perspective is not None else {})}


def normalize_ghost_state(value):
    empty = {"v": 1, "enabled": False, "slots": {}}
    if (not isinstance(value, dict) or type(value.get("v")) is not int or value["v"] != 1
            or type(value.get("enabled")) is not bool or not isinstance(value.get("slots"), dict)
            or any(key not in MATCHUPS for key in value["slots"])):
        return empty
    slots = {}
    for matchup, target in value["slots"].items():
        normalized = normalize_target(target)
        if normalized is None:
            return empty
        slots[matchup] = normalized
    local_only = value.get("localOnlyMatchups", [])
    if not isinstance(local_only, list) or len(local_only) > len(MATCHUPS) or any(matchup not in MATCHUPS for matchup in local_only):
        return empty
    return {"v": 1, "enabled": value["enabled"], "slots": slots,
            **({"localOnlyMatchups": [matchup for matchup in MATCHUPS if matchup in local_only]} if local_only else {})}


def replay_target(game, build, game_id):
    if not isinstance(game, dict) or not isinstance(build, dict):
        raise GhostError("This replay's build order is unavailable.")
    mine = concrete_race(build.get("my_race") or game.get("myRace"))
    opponent = game.get("opponent") if isinstance(game.get("opponent"), dict) else {}
    theirs = concrete_race(build.get("opp_race") or opponent.get("race"))
    if not mine or not theirs:
        raise GhostError("Ghost requires a replay with two concrete races.")
    events = build.get("events")
    if not isinstance(events, list):
        raise GhostError("This replay has no timed build order yet.")
    steps = []
    for event in events[:10000]:
        if not isinstance(event, dict):
            continue
        name = _text(event.get("name"), 64)
        if not name or re.sub(r"[^a-z0-9]", "", name.lower()) in WORKERS:
            continue
        if not _number(event.get("time")):
            continue
        kind = event.get("category")
        if not isinstance(kind, str) or kind not in {"building", "unit", "upgrade", "other"}:
            kind = "building" if event.get("is_building") is True else "other"
        supply = event.get("supply")
        step = {"t": event["time"], "name": name, "kind": kind,
                "supply": supply if _number(supply, 200) else None}
        if _number(event.get("complete_time")) and event["complete_time"] >= event["time"]:
            step["completeTime"] = event["complete_time"]
        steps.append(step)
    steps.sort(key=lambda row: row["t"])
    source_id = game_id if len(game_id) <= 128 else "replay:" + hashlib.sha256(game_id.encode("utf-8")).hexdigest()
    target = normalize_target({"v": 1, "name": build.get("my_build") or game.get("myBuild") or "Replay build",
                               "sourceGameId": source_id, "steps": steps[:MAX_GHOST_STEPS]})
    if target is None:
        raise GhostError("This replay has no usable timed build steps yet.")
    return {"target": target, "matchup": mine + "v" + theirs}


class GhostClient:
    def __init__(self, request, preferences_provider, save_preferences):
        self._request = request
        self._preferences_provider = preferences_provider
        self._save_preferences = save_preferences
        self._lock = threading.RLock()
        self._references = {}
        self._history = {}

    def _merge_account(self, state, account, *, synced_matchups=()):
        if (not isinstance(account, dict) or type(account.get("v")) is not int or account["v"] != 1
                or not isinstance(account.get("slots"), dict) or any(matchup not in MATCHUPS for matchup in account["slots"])):
            return False
        slots = {}
        for matchup, target in account["slots"].items():
            normalized = normalize_target(target)
            if normalized is None:
                return False
            slots[matchup] = normalized
        local_only = set(state.get("localOnlyMatchups", ())) - set(synced_matchups)
        local_slots = state["slots"]
        state["slots"] = slots
        for matchup in local_only:
            if matchup in local_slots:
                state["slots"][matchup] = local_slots[matchup]
            else:
                state["slots"].pop(matchup, None)
        if local_only:
            state["localOnlyMatchups"] = [matchup for matchup in MATCHUPS if matchup in local_only]
        else:
            state.pop("localOnlyMatchups", None)
        references = account.get("references")
        if isinstance(references, dict):
            self._references = {}
            for key, reference in list(references.items())[:100]:
                if not isinstance(key, str) or not isinstance(reference, dict):
                    continue
                target = normalize_target(reference.get("target"))
                if target is not None and reference.get("matchup") in MATCHUPS:
                    self._references[key[:240]] = {**reference, "target": target}
        history = account.get("history")
        if isinstance(history, dict):
            self._history = {}
            for key, entries in list(history.items())[:32]:
                if not isinstance(key, str) or not isinstance(entries, list):
                    continue
                kept = []
                for entry in entries[:3]:
                    if not isinstance(entry, dict) or not isinstance(entry.get("revision"), str):
                        continue
                    target = normalize_target(entry.get("target"))
                    if target is not None and entry.get("matchup") in MATCHUPS:
                        kept.append({**entry, "target": target})
                if kept:
                    self._history[key[:240]] = kept
        return True

    def _result(self, state, *, warning=None):
        return {"ghost": state, "references": deepcopy(self._references), "history": deepcopy(self._history),
                **({"warning": warning} if warning else {})}

    def action(self, request):
        if not isinstance(request, dict):
            raise GhostError("Choose a Ghost action.")
        action = request.get("action")
        if action == "ghost_state":
            with self._lock:
                state = normalize_ghost_state(self._preferences_provider())
                try:
                    account = self._request("GET", "/v1/me/ghost-builds")
                    if not self._merge_account(state, account):
                        raise GhostError("Account builds are unavailable.")
                except Exception:
                    return self._result(state, warning="Account builds are unavailable. Using targets saved on this PC.")
                self._save_preferences(deepcopy(state))
                return self._result(state)
        if action == "ghost_save":
            if not ("enabled" in request or "matchup" in request):
                raise GhostError("Choose a Ghost setting to save.")
            if "enabled" in request and type(request["enabled"]) is not bool:
                raise GhostError("Ghost must be on or off.")
            target = None
            if "matchup" in request:
                if request["matchup"] not in MATCHUPS or "target" not in request:
                    raise GhostError("Choose an exact Ghost matchup.")
                if request["target"] is not None:
                    target = normalize_target(request["target"])
                    if target is None:
                        raise GhostError("Choose a valid timed replay build.")
            with self._lock:
                state = normalize_ghost_state(self._preferences_provider())
                if "enabled" in request:
                    state["enabled"] = request["enabled"]
                if "matchup" in request:
                    if target is None:
                        state["slots"].pop(request["matchup"], None)
                    else:
                        state["slots"][request["matchup"]] = target
                    local_only = set(state.get("localOnlyMatchups", ()))
                    local_only.add(request["matchup"])
                    state["localOnlyMatchups"] = [matchup for matchup in MATCHUPS if matchup in local_only]
                self._save_preferences(deepcopy(state))
                if "matchup" not in request:
                    return self._result(state)
                try:
                    account = self._request("PUT", "/v1/me/ghost-builds", body={"matchup": request["matchup"], "target": target})
                    if not self._merge_account(state, account, synced_matchups=(request["matchup"],)):
                        raise GhostError("Account builds are unavailable.")
                except Exception:
                    return self._result(state, warning="Saved on this PC. Account sync is unavailable; assign the target again to retry.")
                self._save_preferences(deepcopy(state))
                return self._result(state)
        if action == "ghost_reference":
            game_id = request.get("gameId")
            side = request.get("side", "you")
            clear = request.get("clear", False)
            if (not isinstance(game_id, str) or not 0 < len(game_id) <= 200
                    or re.search(r"[\x00-\x1f\x7f]", game_id) or side not in ("you", "opponent") or type(clear) is not bool):
                raise GhostError("Select a replay and player for this build reference.")
            with self._lock:
                state = normalize_ghost_state(self._preferences_provider())
                account = self._request("PUT", "/v1/me/ghost-builds/reference", body={"gameId": game_id, "side": side, "clear": clear})
                references = account.get("references") if isinstance(account, dict) else None
                affected = [reference.get("matchup") for reference in references.values()
                            if isinstance(reference, dict) and reference.get("gameId") == game_id and reference.get("side", "you") == side] if isinstance(references, dict) and not clear else []
                if not self._merge_account(state, account, synced_matchups=affected):
                    raise GhostError("The reference replay could not be synced. Please refresh.")
                self._save_preferences(deepcopy(state))
                return self._result(state)
        if action == "ghost_examples":
            result = self._request("GET", "/v1/ghost-examples")
            items = result.get("items") if isinstance(result, dict) else None
            return {"items": [row for row in items[:100] if isinstance(row, dict)] if isinstance(items, list) else []}
        if action == "ghost_reference_restore":
            key, revision = request.get("referenceKey"), request.get("revision")
            expected = request.get("expectedCurrentRevision")
            if (not isinstance(key, str) or not 0 < len(key) <= 200
                    or not isinstance(revision, str) or not 0 < len(revision) <= 80
                    or expected is not None and (not isinstance(expected, str) or not 0 < len(expected) <= 80)
                    or any(re.search(r"[\x00-\x1f\x7f]", value) for value in (key, revision, expected or ""))):
                raise GhostError("Choose a saved reference from history, then refresh before restoring it.")
            with self._lock:
                state = normalize_ghost_state(self._preferences_provider())
                account = self._request("PUT", "/v1/me/ghost-builds/reference/restore", body={
                    "referenceKey": key, "revision": revision, "expectedCurrentRevision": expected,
                })
                reference = account.get("references", {}).get(key) if isinstance(account, dict) and isinstance(account.get("references"), dict) else None
                affected = [reference["matchup"]] if isinstance(reference, dict) and reference.get("matchup") in MATCHUPS else []
                if not self._merge_account(state, account, synced_matchups=affected):
                    raise GhostError("The saved reference could not be restored. Refresh history and try again.")
                self._save_preferences(deepcopy(state))
                return self._result(state)
        if action == "ghost_comparison":
            game_id, side = request.get("gameId"), request.get("side", "you")
            build_key = request.get("buildKey")
            if (not isinstance(game_id, str) or not 0 < len(game_id) <= 200 or side not in ("you", "opponent")
                    or re.search(r"[\x00-\x1f\x7f]", game_id)
                    or build_key is not None and (not isinstance(build_key, str) or not 0 < len(build_key) <= 160
                                                 or re.search(r"[\x00-\x1f\x7f]", build_key))):
                raise GhostError("Choose a replay and player to compare.")
            params = {"gameId": game_id, "side": side}
            if build_key is not None:
                params["buildKey"] = build_key
            result = self._request("GET", "/v1/me/ghost-builds/comparison", params=params)
            if not isinstance(result, dict) or result.get("status") not in ("ready", "no_reference", "source_replay", "replay_pending"):
                raise GhostError("This replay's reference comparison is unavailable.")
            rows = result.get("rows")
            return {**result, "rows": [row for row in rows[:MAX_GHOST_STEPS] if isinstance(row, dict)] if isinstance(rows, list) else []}
        if action == "ghost_example_target":
            example_id = request.get("exampleId")
            if not isinstance(example_id, str) or not 0 < len(example_id) <= 128 or re.search(r"[\x00-\x1f\x7f]", example_id):
                raise GhostError("Choose a curated replay example first.")
            result = self._request("GET", "/v1/ghost-examples/" + quote(example_id, safe=""))
            target = normalize_target(result.get("target")) if isinstance(result, dict) else None
            matchup = result.get("matchup") if isinstance(result, dict) else None
            if target is None or matchup not in MATCHUPS:
                raise GhostError("This example's timed build is unavailable.")
            return {"target": target, "matchup": matchup}
        if action == "ghost_games":
            params = {"limit": 50}
            before = request.get("before")
            if before is not None:
                if not isinstance(before, str) or not 0 < len(before) <= 64:
                    raise GhostError("Refresh the replay library and try again.")
                params["before"] = before
            result = self._request("GET", "/v1/games", params=params)
            return {"items": result.get("items", [])[:50] if isinstance(result.get("items"), list) else [],
                    "nextBefore": result.get("nextBefore")}
        if action == "ghost_target":
            game_id = request.get("gameId")
            if (not isinstance(game_id, str) or not 0 < len(game_id) <= 200
                    or re.search(r"[\x00-\x1f\x7f]", game_id)):
                raise GhostError("Select a replay from your library first.")
            path = "/v1/games/" + quote(game_id, safe="")
            game = self._request("GET", path)
            if not supports_ghost_game(game):
                raise GhostError("Build Order Ghost supports one-versus-one replays. Team and free-for-all targets are unavailable.")
            build = self._request("GET", path + "/build-order")
            if not isinstance(game, dict) or not isinstance(build, dict):
                raise GhostError("This replay's build order is unavailable.")
            players = []
            opponent = game.get("opponent") if isinstance(game.get("opponent"), dict) else {}
            for side, name, side_build in (
                ("you", "You", build),
                ("opponent", opponent.get("displayName") or build.get("opponent") or "Opponent", {
                    **build, "my_race": build.get("opp_race") or opponent.get("race"),
                    "opp_race": build.get("my_race") or game.get("myRace"),
                    "my_build": build.get("opp_strategy") or "Opponent replay build",
                    "events": build.get("opp_events"),
                }),
            ):
                try:
                    candidate = replay_target(game, side_build, game_id)
                except GhostError:
                    continue
                candidate["target"]["perspective"] = side
                players.append({"id": side, "name": name, "race": candidate["matchup"][0],
                                "opponentRace": candidate["matchup"][2], **candidate})
            if not players:
                raise GhostError("This replay has no usable timed build steps yet.")
            return {"target": players[0]["target"], "matchup": players[0]["matchup"], "players": players}
        raise GhostError("This Ghost action is unavailable.")


class GhostSession:
    def __init__(self):
        self._envelope = {}
        self.game_key = None
        self._random_blocked = False

    def update_snapshot(self, snapshot):
        envelope = snapshot.get("liveGame") if isinstance(snapshot, dict) else None
        self._envelope = deepcopy(envelope) if isinstance(envelope, dict) else {}
        key = self._envelope.get("gameKey")
        active = self._envelope.get("phase") in {"match_loading", "match_started", "match_in_progress"}
        if not active or not isinstance(key, str) or not key:
            self.game_key = None
            self._random_blocked = False
            return
        if key != self.game_key:
            self.game_key = key
            self._random_blocked = False
        user = self._envelope.get("user") or {}
        opponent = self._envelope.get("opponent") or {}
        races = [row.get("race") for row in [user, opponent] if isinstance(row, dict)]
        if any(isinstance(race, str) and (race.strip().lower() == "r" or race.strip().lower().startswith("random")) for race in races):
            self._random_blocked = True

    def view(self, state, *, now=None):
        envelope = self._envelope
        if envelope.get("phase") not in {"match_started", "match_in_progress"} or envelope.get("isReplay") is True or not self.game_key:
            return None, "Waiting for a live game"
        players = envelope.get("players")
        active_players = [player for player in players if isinstance(player, dict) and player.get("isObserver") is not True
                          and str(player.get("type", "")).lower() != "observer"] if isinstance(players, list) else []
        if not supports_ghost_game(envelope) or len(active_players) > 2:
            return None, "Ghost supports 1v1 games only · team targets are unavailable"
        timestamp = envelope.get("receivedAt")
        timestamp = timestamp / 1000 if _number(timestamp, 1e14) else envelope.get("capturedAt")
        current = time.time() if now is None else now
        if not _number(timestamp, 1e14) or not -5 <= current - timestamp <= 30:
            return None, "Waiting for fresh SC2 telemetry"
        clock = envelope.get("displayTime")
        if not _number(clock):
            return None, "Waiting for the SC2 game clock"
        user = envelope.get("user") if isinstance(envelope.get("user"), dict) else {}
        opponent = envelope.get("opponent") if isinstance(envelope.get("opponent"), dict) else {}
        mine, theirs = concrete_race(user.get("race")), concrete_race(opponent.get("race"))
        if self._random_blocked or not mine or not theirs:
            return None, "Ghost requires two concrete live races"
        matchup = mine + "v" + theirs
        target = state.get("slots", {}).get(matchup)
        if not target:
            return None, "No replay target assigned to " + matchup
        passed = sum(step["t"] <= clock for step in target["steps"])
        index = max(0, passed - 1)
        return {"target": target, "clock": clock, "matchup": matchup, "index": index,
                "passed": passed, "complete": passed == len(target["steps"])}, "Following " + matchup + " target timings"
