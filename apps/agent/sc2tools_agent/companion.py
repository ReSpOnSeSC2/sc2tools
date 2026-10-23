"""Account-backed data and saved preferences for the native Companion."""

from __future__ import annotations

import threading
from urllib.parse import quote, urlparse

import requests


DEFAULT_PREFERENCES = {
    "overlaysEnabled": False,
    "opponentOverlay": False,
    "scoutingOverlay": False,
}


def normalize_preferences(value):
    source = value if isinstance(value, dict) else {}
    return {
        key: source.get(key) if type(source.get(key)) is bool else default
        for key, default in DEFAULT_PREFERENCES.items()
    }


class CompanionError(ValueError):
    """A user-readable failure without server responses or credentials."""


class CompanionClient:
    def __init__(self, connection_provider, *, preferences_provider=None,
                 save_preferences=None, transport=None):
        self._connection_provider = connection_provider
        self._preferences_provider = preferences_provider or (lambda: {})
        self._save_preferences = save_preferences
        self._transport = transport or requests.request
        self._preference_lock = threading.RLock()

    def action(self, request):
        if not isinstance(request, dict):
            raise CompanionError("Choose a Companion action.")
        action = request.get("action")
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
            _, token = self._connection_provider()
            if not token:
                return {"paired": False, "liveGame": None, "live": None,
                        "preferences": preferences}
            snapshot = self._request("GET", "/v1/me/live/snapshot")
            envelope = snapshot.get("liveGame")
            live = snapshot.get("overlayLive")
            if isinstance(envelope, dict) and envelope.get("phase") in {
                "match_loading", "match_started", "match_in_progress", "match_ended",
            }:
                game_key = envelope.get("gameKey")
                if not (game_key and isinstance(live, dict) and live.get("gameKey") == game_key):
                    live = None
            return {"paired": True,
                    "liveGame": envelope,
                    "live": live,
                    "preferences": preferences}
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

    def _request(self, method, path, *, params=None, body=None):
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
            raise CompanionError("This data is unavailable. The Companion also needs the matching server update.")
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
        return payload
