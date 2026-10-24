"""Account-backed data and saved preferences for the native Companion."""

from __future__ import annotations

import threading
from copy import deepcopy
import hashlib
import re
from urllib.parse import quote, urlparse

import requests
from .companion_modes import normalize_modes, validate_modes


DEFAULT_PREFERENCES = {
    "overlaysEnabled": False,
    "opponentOverlay": False,
    "scoutingOverlay": False,
    "scoutingReadAloud": False,
}


def normalize_preferences(value):
    source = value if isinstance(value, dict) else {}
    return {
        key: source.get(key) if type(source.get(key)) is bool else default
        for key, default in DEFAULT_PREFERENCES.items()
    }


class CompanionError(ValueError):
    """A user-readable failure without server responses or credentials."""

    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code


class CompanionClient:
    def __init__(self, connection_provider, *, preferences_provider=None,
                 save_preferences=None, modes_provider=None, save_modes=None, transport=None):
        self._connection_provider = connection_provider
        self._preferences_provider = preferences_provider or (lambda: {})
        self._save_preferences = save_preferences
        self._modes_provider = modes_provider
        self._save_modes = save_modes
        self._transport = transport or requests.request
        self._preference_lock = threading.RLock()

    def action(self, request):
        if not isinstance(request, dict):
            raise CompanionError("Choose a Companion action.")
        action = request.get("action")
        if action == "companion_modes":
            with self._preference_lock:
                if "modes" in request:
                    try:
                        modes = validate_modes(request["modes"])
                    except ValueError as error:
                        raise CompanionError(str(error)) from None
                    if self._save_modes is None:
                        raise CompanionError("Local Companion modes could not be saved.")
                    try:
                        self._save_modes(modes)
                    except OSError:
                        raise CompanionError("Local Companion modes could not be saved. Check your disk and try again.") from None
                modes = normalize_modes(self._modes_provider() if self._modes_provider else {})
                preferences = normalize_preferences(self._preferences_provider())
            return {"modes": modes, **({"preferences": preferences} if "modes" not in request else {})}
        if action == "preferences":
            updates = request.get("preferences")
            if not isinstance(updates, dict) or any(
                key not in DEFAULT_PREFERENCES or type(value) is not bool
                for key, value in updates.items()
            ):
                raise CompanionError("Overlay preferences must be on or off.")
            with self._preference_lock:
                preferences = normalize_preferences(self._preferences_provider())
                preferences.update(updates)
                if self._save_preferences is None:
                    raise CompanionError("Overlay preferences could not be saved.")
                self._save_preferences(dict(preferences))
            return {"preferences": preferences}
        if action == "snapshot":
            preferences = normalize_preferences(self._preferences_provider())
            modes = {"modes": normalize_modes(self._modes_provider())} if self._modes_provider else {}
            base, token = self._connection_provider()
            if not token:
                return {"paired": False, "liveGame": None, "live": None,
                        "preferences": preferences, **modes}
            snapshot = self._request("GET", "/v1/me/live/snapshot")
            envelope = snapshot.get("liveGame")
            live = snapshot.get("overlayLive")
            if isinstance(envelope, dict) and envelope.get("phase") in {
                "match_loading", "match_started", "match_in_progress", "match_ended",
            }:
                game_key = envelope.get("gameKey")
                if not (game_key and isinstance(live, dict) and live.get("gameKey") == game_key):
                    live = None
            return {"paired": True, "accountKey": hashlib.sha256((base + "\0" + token).encode("utf-8")).hexdigest(),
                    "liveGame": envelope,
                    "live": live,
                    "preferences": preferences, **modes}
        if action in {"randomizer_state", "randomizer_settings", "randomizer_roll"}:
            return self._randomizer_action(request)
        if action in {"game_build_order", "game_summary"}:
            game_id = request.get("gameId")
            if (not isinstance(game_id, str) or not game_id.strip()
                    or game_id != game_id.strip() or len(game_id) > 200
                    or game_id in {".", ".."}
                    or any(ord(character) < 32 or ord(character) == 127 for character in game_id)):
                raise CompanionError("Select a valid replay first.")
            try:
                encoded_id = quote(game_id, safe="")
            except UnicodeEncodeError:
                raise CompanionError("Select a valid replay first.") from None
            if action == "game_summary":
                return self._request("GET", "/v1/games/" + encoded_id, missing_ok=True)
            return self._request("GET", "/v1/games/" + encoded_id + "/build-order")
        if action == "opponents":
            params = {"limit": 100}
            before = request.get("before")
            if isinstance(before, str) and before:
                params["before"] = before
            page = self._request("GET", "/v1/opponents", params=params)
            items = page.get("items")
            normalized = []
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, dict) or not item.get("pulseId"):
                    continue
                row = dict(item)
                row["name"] = (item.get("name") or item.get("revealedName")
                               or item.get("displayNameSample") or "Unknown opponent")
                row["displayName"] = row["name"]
                row["total"] = item.get("gameCount")
                normalized.append(row)
            return {**page, "items": normalized, "nextCursor": page.get("nextBefore")}
        if action in {"opponent", "save_notes"}:
            pulse_id = request.get("pulseId")
            if not isinstance(pulse_id, str) or not pulse_id.strip():
                raise CompanionError("Select an opponent first.")
            path = "/v1/opponents/" + quote(pulse_id, safe="")
            if action == "opponent":
                return self._request("GET", path)
            text = request.get("text")
            read_aloud = request.get("readAloud", False)
            if (not isinstance(text, str) or len(text.encode("utf-16-le")) // 2 > 500
                    or type(read_aloud) is not bool):
                raise CompanionError("Notes can contain at most 500 characters.")
            return self._request("PUT", path + "/notes", body={
                "notes": text, "notesReadAloud": read_aloud,
            })
        raise CompanionError("This Companion action is unavailable.")

    def _randomizer_action(self, request):
        action = request["action"]
        matchup = request.get("matchup")
        if not isinstance(matchup, str) or not re.fullmatch(r"[PTZ]v[PTZ]", matchup):
            raise CompanionError("Choose a concrete matchup for the randomizer.")
        game_key = request.get("gameKey")
        if game_key is not None and (not isinstance(game_key, str) or not game_key
                                     or len(game_key) > 500 or not re.search(r"\|[0-9]{1,16}$", game_key)):
            raise CompanionError("Refresh the current game before rolling.")
        if action == "randomizer_roll":
            release_hold = request.get("releaseHold")
            if not game_key or type(release_hold) is not bool:
                raise CompanionError("Choose Roll now during a current match.")
            return self._request("POST", "/v1/build-intents/live/" + quote(game_key, safe="") + "/randomizer",
                                 body={"matchup": matchup, "releaseHold": release_hold})
        config = self._request("GET", "/v1/me/preferences/randomizer")
        if action == "randomizer_state":
            options = self._request("GET", "/v1/build-intents/options", params={"matchup": matchup})
            intent = self._request("GET", "/v1/build-intents/live/" + quote(game_key, safe=""), missing_ok=True) if game_key else None
            return {"config": config, "options": options, "intent": intent}
        if "enabled" in request and type(request["enabled"]) is not bool:
            raise CompanionError("The randomizer switch must be on or off.")
        if "enabled" not in request and "buildKeys" not in request:
            raise CompanionError("Choose a randomizer setting to save.")
        config = deepcopy(config)
        if not isinstance(config.get("matchups"), dict):
            config["matchups"] = {}
        current = config["matchups"].get(matchup)
        current = deepcopy(current) if isinstance(current, dict) else {
            "enabled": False, "useCustomWeights": False,
            "unitRandomizerEnabled": matchup.startswith("P"), "builds": [],
        }
        if "buildKeys" in request:
            keys = request["buildKeys"]
            if (not isinstance(keys, list) or len(keys) > 500
                    or any(not isinstance(key, str) or not key or len(key) > 200 for key in keys)
                    or len(set(keys)) != len(keys)):
                raise CompanionError("Choose valid builds for this randomizer pool.")
            options = self._request("GET", "/v1/build-intents/options", params={"matchup": matchup})
            available = {row.get("key"): row for row in options.get("builds", []) if isinstance(row, dict)}
            if any(key not in available for key in keys):
                raise CompanionError("A build is no longer available for this matchup. Refresh the pool.")
            existing = {row.get("id"): row for row in current.get("builds", []) if isinstance(row, dict)}
            current["builds"] = [{
                **existing.get(key, {}), "id": key, "name": available[key]["name"],
                "race": {"P": "Protoss", "T": "Terran", "Z": "Zerg"}[matchup[0]],
                "source": available[key].get("source", "catalog"), "weight": existing.get(key, {}).get("weight", 1),
            } for key in keys]
        if "enabled" in request:
            current["enabled"] = request["enabled"]
        config["matchups"][matchup] = current
        config.setdefault("version", 2)
        saved = self._request("PUT", "/v1/me/preferences/randomizer", body=config)
        return {"config": saved}

    def _request(self, method, path, *, params=None, body=None, missing_ok=False):
        base, token = self._connection_provider()
        if not token:
            raise CompanionError("Pair this agent with your SC2 Tools account first.")
        try:
            parsed = urlparse(base)
            secure = parsed.scheme == "https" or (
                parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            )
            if (not secure or not parsed.hostname or parsed.username or parsed.password
                    or parsed.query or parsed.fragment):
                raise ValueError("invalid_api_address")
        except (TypeError, ValueError):
            raise CompanionError("Check the SC2 Tools API address in Settings.") from None
        try:
            response = self._transport(
                method, base.rstrip("/") + path,
                headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
                params=params, json=body, timeout=(3.05, 8), allow_redirects=False,
            )
        except requests.RequestException:
            raise CompanionError("Cannot reach SC2 Tools. Check your connection and refresh.") from None
        if response.status_code in {401, 403}:
            raise CompanionError("Your agent pairing is no longer authorized. Pair the agent again.")
        if response.status_code == 404:
            if missing_ok:
                return {}
            raise CompanionError("This data is unavailable. The Companion also needs the matching server update.")
        if response.status_code == 409:
            try:
                code = response.json().get("error", {}).get("code")
            except (ValueError, AttributeError):
                code = None
            messages = {
                "stale_game": "This game is no longer current. Refresh the Companion.",
                "matchup_changed": "The current matchup changed. Refresh before rolling.",
                "build_declared": "Your declared build is already selected for this game.",
                "randomizer_disabled": "Enable the randomizer and select at least one build for this matchup.",
                "hold_active": "Waiting for the loading check-in. Choose Roll now or wait for the match to start.",
                "unknown_build": "An eligible build is no longer available. Refresh and edit the pool.",
                "already_bound": "This game is already saved. The next match can receive a new roll.",
                "pool_changed": "The randomizer pool changed. Refresh before rolling.",
            }
            raise CompanionError(messages.get(code, "The randomizer state changed. Refresh and try again."), code=code)
        if response.status_code == 429:
            raise CompanionError("SC2 Tools is busy. Please wait a moment and refresh.")
        if not 200 <= response.status_code < 300:
            raise CompanionError("Companion data could not be loaded. Please refresh.")
        try:
            payload = response.json()
        except ValueError:
            raise CompanionError("Companion data could not be read. Please refresh.") from None
        if not isinstance(payload, dict):
            raise CompanionError("Companion data could not be read. Please refresh.")
        try:
            current_connection = tuple(self._connection_provider())
        except (TypeError, ValueError):
            current_connection = None
        if current_connection != (base, token):
            raise CompanionError("Your agent pairing changed. Refresh before using account data.")
        return payload
