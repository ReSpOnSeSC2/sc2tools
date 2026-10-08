"""Own-Desktop Google OAuth/API adapter. Import never starts auth/API.

No browser cookies, private Google endpoints or stream-key creation. Credentials
use the injected runtime directory and encrypted per-user secret storage.
"""

import base64
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import secrets
import threading
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen
import webbrowser

from .common import HelperError
from .secret_store import read_json, write_json

SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl"
AUTH = "https://accounts.google.com/o/oauth2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3/"
CLIENT_FILE = "youtube-desktop-client.dpapi"
TOKEN_FILE = "youtube-oauth.dpapi"


def _runtime_directory(directory):
    if not isinstance(directory, (str, Path)) or not str(directory):
        raise HelperError("An explicit streaming runtime directory is required.")
    path = Path(directory)
    if not path.is_absolute():
        raise HelperError("An absolute streaming runtime directory is required.")
    return path


def _validated_client(config):
    client = config.get("installed") if isinstance(config, dict) else None
    if not isinstance(client, dict) or any(not isinstance(client.get(key), str) or not client[key] for key in ("client_id", "client_secret")):
        raise HelperError("Select this app's own Google Desktop OAuth client JSON.")
    if client.get("auth_uri") not in {AUTH, "https://accounts.google.com/o/oauth2/v2/auth"} or client.get("token_uri") != TOKEN:
        raise HelperError("Desktop client must use official Google authorization/token endpoints.")
    return client


def import_desktop_client(source_path, directory, explicit=False):
    """Import a user-selected Desktop client only after an explicit action."""
    if explicit is not True:
        return {"status": "desktop_client_import_not_started", "credentials_changed": False}
    directory = _runtime_directory(directory)
    try:
        config = json.loads(Path(source_path).read_text(encoding="utf-8-sig"))
        _validated_client(config)
    except HelperError:
        raise
    except Exception:
        raise HelperError("The selected Desktop OAuth client could not be read.") from None
    try:
        write_json(directory / CLIENT_FILE, config)
    except Exception:
        raise HelperError("The Desktop client could not be saved in per-user credential storage.") from None
    return {"status": "own_desktop_client_saved", "credentials_changed": True, "credential_values_printed": False}


def read_own_client(directory):
    directory = _runtime_directory(directory)
    try:
        config = read_json(directory / CLIENT_FILE)
    except Exception:
        raise HelperError("Import this app's own Google Desktop client before connecting YouTube.") from None
    return _validated_client(config)


def token_post(values):
    request = Request(TOKEN, data=urlencode(values).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except HTTPError as error:
        raise HelperError(f"Own Google OAuth token operation failed with HTTP{error.code}; response withheld.")


def authorize_desktop(directory, explicit=False):
    """No-op by default; explicit user connection opens Desktop PKCE consent."""
    if explicit is not True:
        return {"status": "own_desktop_authorization_not_started", "authorization_started": False}
    directory = _runtime_directory(directory)
    client = read_own_client(directory)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    received = {}

    class BoundedLoopback(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(3)
            return connection, address

        def handle_error(self, *args):
            pass  # Never log OAuth callback query/code on malformed requests.

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            split = urlsplit(self.path)
            if split.path != "/oauth2callback":
                self.send_response(404)
                self.end_headers()
                return
            query = parse_qs(split.query)
            if query.get("state") != [state]:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Authorization state validation failed.")
                return
            if query.get("error"):
                received["denied"] = True
            elif len(query.get("code", [])) == 1:
                received["code"] = query["code"][0]
            else:
                received["invalid"] = True
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Authorization received. Return to the local helper.")

    with BoundedLoopback(("127.0.0.1", 0), Callback) as server:
        server.timeout = 0.5
        redirect = f"http://127.0.0.1:{server.server_port}/oauth2callback"
        url = AUTH + "?" + urlencode({
            "client_id": client["client_id"], "redirect_uri": redirect,
            "response_type": "code", "scope": SCOPE, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256",
            "access_type": "offline", "prompt": "consent",
        })
        if not webbrowser.open(url, new=1):
            raise HelperError("System browser could not open the own-client OAuth consent flow.")
        deadline = time.monotonic() + 180
        while not received and time.monotonic() < deadline:
            server.handle_request()
    if not received.get("code"):
        raise HelperError("Own Desktop OAuth consent did not complete within the bounded window.")
    tokens = token_post({
        "code": received["code"], "client_id": client["client_id"],
        "client_secret": client["client_secret"], "redirect_uri": redirect,
        "grant_type": "authorization_code", "code_verifier": verifier,
    })
    if not tokens.get("access_token") or not tokens.get("refresh_token") or SCOPE not in tokens.get("scope", "").split():
        raise HelperError("Own Desktop OAuth did not provide the required refresh token/scope.")
    tokens.update(provenance="own-desktop-client", own_client_id=client["client_id"], expires_at=time.time() + int(tokens.get("expires_in", 3600)))
    try:
        write_json(directory / TOKEN_FILE, tokens)
    except Exception:
        raise HelperError("YouTube authorization could not be saved in per-user credential storage.") from None
    return {"status": "own_desktop_oauth_saved_privately", "authorization_started": True, "token_values_printed": False, "stream_keys_or_broadcasts_changed": False}


class OwnDesktopCredentials:
    def __init__(self, directory):
        self.directory = _runtime_directory(directory)
        self._refresh_lock = threading.RLock()
        self.client = read_own_client(directory)
        self.path = self.directory / TOKEN_FILE
        try:
            self.tokens = read_json(self.path)
        except Exception:
            raise HelperError("Connect YouTube using this app's own Desktop client.") from None
        if self.tokens.get("provenance") != "own-desktop-client" or self.tokens.get("own_client_id") != self.client["client_id"] or not isinstance(self.tokens.get("scope"), str) or SCOPE not in self.tokens["scope"].split() or not isinstance(self.tokens.get("access_token"), str) or not self.tokens["access_token"]:
            raise HelperError("OAuth tokens must belong to this helper's own Desktop client and approved scope.")

    def access_token(self):
        with self._refresh_lock:
            if time.time() >= self.tokens.get("expires_at", 0) - 60:
                if not self.tokens.get("refresh_token"):
                    raise HelperError("Own Desktop refresh token unavailable; explicit reauthorization required.")
                refreshed = token_post({
                    "client_id": self.client["client_id"], "client_secret": self.client["client_secret"],
                    "refresh_token": self.tokens["refresh_token"], "grant_type": "refresh_token",
                })
                if not isinstance(refreshed, dict) or not isinstance(refreshed.get("access_token"), str) or not refreshed["access_token"]:
                    raise HelperError("Own Desktop OAuth refresh failed.")
                candidate = copy.deepcopy(self.tokens)
                candidate.update(refreshed)
                if not isinstance(candidate.get("scope"), str) or SCOPE not in candidate["scope"].split():
                    raise HelperError("Own Desktop OAuth refresh did not retain the approved scope.")
                candidate["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
                try:
                    write_json(self.path, candidate)
                except Exception:
                    raise HelperError("Refreshed YouTube authorization could not be saved; reconnect before continuing.") from None
                # Persist first: a storage error must not leave only memory
                # holding a new token while disk still contains the old one.
                self.tokens = candidate
            return self.tokens["access_token"]


class GoogleAPI:
    def __init__(self, credentials, write_enabled=False):
        self.credentials, self.write_enabled = credentials, write_enabled

    def request(self, resource, params, body=None, *, method=None):
        methods = {
            "liveBroadcasts": {"GET", "POST"},
            "liveBroadcasts/bind": {"POST"},
            "liveStreams": {"GET"},
            "videos": {"GET", "PUT"},
            "channels": {"GET"},
        }
        if resource not in methods:
            raise HelperError("Request is outside the documented lifecycle adapter.")
        if method is None:
            method = "POST" if body is not None or resource.endswith("/bind") else "GET"
        if method not in methods[resource]:
            raise HelperError("HTTP method is outside the documented lifecycle adapter.")
        if method != "GET" and not self.write_enabled:
            raise HelperError("Google write mode was not explicitly enabled.")
        if method == "GET" and body is not None:
            raise HelperError("Documented list operations cannot receive a write body.")
        if method in {"POST", "PUT"} and resource != "liveBroadcasts/bind" and not isinstance(body, dict):
            raise HelperError("Documented metadata writes require a resource body.")
        url = API + resource + "?" + urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        request = Request(url, data=data, method=method, headers={"Authorization": "Bearer " + self.credentials.access_token(), "Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=15) as response:
                return json.loads(response.read())
        except HTTPError as error:
            safe = HelperError(f"Documented YouTube lifecycle operation failed with HTTP{error.code}; private response withheld.")
            safe.http_status = error.code if isinstance(error.code, int) and 100 <= error.code <= 599 else None
            raise safe from None

    def paginated(self, resource, params):
        rows = []
        for _ in range(10):
            result = self.request(resource, params)
            rows.extend(self.items(result, resource))
            next_page = result.get("nextPageToken")
            if not next_page:
                return rows
            params = {**params, "pageToken": next_page}
        raise HelperError("Discovery pagination exceeded the bounded limit; absence of conflicts is unknown.")

    @staticmethod
    def items(result, resource=None):
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise HelperError("Documented list response schema was incomplete; discovery result is unknown.")
        for row in result["items"]:
            if not isinstance(row, dict) or not row.get("id") or not isinstance(row.get("snippet"), dict) or not row["snippet"].get("channelId"):
                raise HelperError("Documented resource identity schema was incomplete; discovery result is unknown.")
            if resource not in {"videos", "channels"} and not isinstance(row.get("status"), dict):
                raise HelperError("Documented resource identity/status schema was incomplete; discovery result is unknown.")
            if resource == "liveBroadcasts" and not isinstance(row.get("contentDetails"), dict):
                raise HelperError("Requested broadcast binding details were unavailable; discovery result is unknown.")
        return result["items"]

    def streams_by_ids(self, ids):
        return self.items(self.request("liveStreams", {"part": "id,snippet,cdn,status", "id": ",".join(ids)}))

    def all_streams(self):
        return self.paginated("liveStreams", {"part": "id,snippet,cdn,status", "mine": "true", "maxResults": 50})

    def owned_channel(self):
        """Return only public channel identity; require an unambiguous owner."""
        result = self.request("channels", {"part": "snippet", "mine": "true", "maxResults": 50})
        if not isinstance(result, dict) or not isinstance(result.get("items"), list) or len(result["items"]) != 1 or result.get("nextPageToken"):
            raise HelperError("Select an unambiguous YouTube channel before preparing streams.")
        row = result["items"][0]
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"] or not isinstance(row.get("snippet"), dict) or not isinstance(row["snippet"].get("title"), str):
            raise HelperError("Owned YouTube channel identity was unavailable.")
        return {"id": row["id"], "title": row["snippet"]["title"]}

    def discover_reusable_streams_for_channel(self, expected_channel_id):
        """List existing stream choices without returning ingestion keys.

        liveStreams.list(mine=true) explicitly excludes non-reusable streams;
        only id lookup can return those. The list contract supplies the reuse
        guarantee even when contentDetails is absent from its documented parts.
        https://developers.google.com/youtube/v3/live/docs/liveStreams#contentDetails.isReusable
        """
        if not isinstance(expected_channel_id, str) or not expected_channel_id:
            raise HelperError("Pin the chosen YouTube channel before stream discovery.")
        if self.owned_channel()["id"] != expected_channel_id:
            raise HelperError("Authorized YouTube channel differs from the selected channel.")
        choices = []
        seen = set()
        for row in self.all_streams():
            if row["snippet"]["channelId"] != expected_channel_id or not isinstance(row["id"], str) or row["id"] in seen or not isinstance(row["snippet"].get("title"), str):
                raise HelperError("Existing stream identity/ownership was ambiguous.")
            if isinstance(row.get("contentDetails"), dict) and row["contentDetails"].get("isReusable") is False:
                raise HelperError("Discovery returned a non-reusable stream; select existing reusable keys.")
            seen.add(row["id"])
            choices.append({"id": row["id"], "title": row["snippet"]["title"], "channel": expected_channel_id})
        return choices

    def all_owned_broadcasts(self):
        # Exactly ONE filter: mine. Do not combine mine and broadcastStatus.
        return self.paginated("liveBroadcasts", {"part": "id,snippet,status,contentDetails", "mine": "true", "broadcastType": "all", "maxResults": 50})

    def occupied_broadcasts(self):
        """Read active + upcoming events without scanning completed history.

        Exactly one documented filter per call: broadcastStatus, never mine.
        Both independently bounded page sequences must finish. The API describes
        active as current live events and upcoming as not yet started; it does
        not explicitly guarantee how testing/transitioning events are grouped.
        A caller must also verify selected stream ingest is inactive before a
        new prepare and reject unknown lifecycle/binding information. This is
        not a claim of a transactional/exhaustive snapshot across the two lists.
        https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list
        """
        by_id = {}
        for status in ("active", "upcoming"):
            rows = self.paginated("liveBroadcasts", {"part": "id,snippet,status,contentDetails", "broadcastStatus": status, "broadcastType": "all", "maxResults": 50})
            for row in rows:
                previous = by_id.get(row["id"])
                if previous is not None and (
                    previous["snippet"]["channelId"] != row["snippet"]["channelId"]
                    or previous["contentDetails"].get("boundStreamId") != row["contentDetails"].get("boundStreamId")
                ):
                    raise HelperError("Occupied event ownership/binding changed during discovery; conflicts are unknown.")
                by_id.setdefault(row["id"], row)
        return list(by_id.values())

    def broadcast_by_id(self, broadcast_id):
        return self.broadcasts_by_ids([broadcast_id])[0]

    def broadcasts_by_ids(self, ids):
        """Read one bounded batch; return exact IDs in requested order.

        Channel ownership is exposed as snippet.channelId for the lifecycle
        caller to compare with its pinned channel. Missing, duplicate or foreign
        response IDs are errors, never an apparent completed/absent event.
        """
        if not isinstance(ids, (list, tuple)) or not 1 <= len(ids) <= 50:
            raise HelperError("Tracked broadcast lookup requires 1-50 distinct IDs.")
        if any(not isinstance(value, str) or not value or "," in value for value in ids) or len(set(ids)) != len(ids):
            raise HelperError("Tracked broadcast lookup requires 1-50 distinct IDs.")
        rows = self.items(self.request("liveBroadcasts", {"part": "id,snippet,status,contentDetails", "id": ",".join(ids), "maxResults": 50}), "liveBroadcasts")
        by_id = {row["id"]: row for row in rows}
        if len(by_id) != len(rows) or set(by_id) != set(ids):
            raise HelperError("Tracked broadcast batch was missing, unexpected or ambiguous.")
        for row in rows:
            if not isinstance(row["status"].get("lifeCycleStatus"), str) or not row["status"]["lifeCycleStatus"]:
                raise HelperError("Tracked broadcast lifecycle was unavailable; status is unknown.")
        return [by_id[value] for value in ids]

    def update_video_metadata(self, broadcast_id, title, description, expected_channel_id):
        """Update only an owned video's title/description with snippet PUT.

        videos.update replaces mutable values in each selected part. Read the
        existing snippet first, preserve its mutable category/tags/languages,
        and exclude read-only snippet fields and every other part (especially
        status/privacy). Do not retry an uncertain write automatically.

        Official contracts:
        https://developers.google.com/youtube/v3/docs/videos/update
        https://developers.google.com/youtube/v3/docs/videos
        """
        if not self.write_enabled:
            raise HelperError("Google write mode was not explicitly enabled.")
        if not isinstance(broadcast_id, str) or not broadcast_id or "," in broadcast_id or not isinstance(expected_channel_id, str) or not expected_channel_id:
            raise HelperError("Explicit video and expected channel identities are required.")
        if not isinstance(title, str) or not title.strip() or len(title) > 100 or "<" in title or ">" in title:
            raise HelperError("Video title must be 1-100 valid UTF-8 characters without angle brackets.")
        if not isinstance(description, str) or "<" in description or ">" in description:
            raise HelperError("Video description must be valid UTF-8 text without angle brackets.")
        try:
            title.encode("utf-8")
            description_bytes = len(description.encode("utf-8"))
        except UnicodeEncodeError:
            raise HelperError("Video metadata must contain valid UTF-8 text.") from None
        if description_bytes > 5000:
            raise HelperError("Video description exceeds the 5000-byte UTF-8 limit.")
        rows = self.items(self.request("videos", {"part": "snippet", "id": broadcast_id}), "videos")
        if len(rows) != 1 or rows[0]["id"] != broadcast_id or rows[0]["snippet"]["channelId"] != expected_channel_id:
            raise HelperError("Requested video identity/ownership could not be verified; no metadata write performed.")
        existing = rows[0]["snippet"]
        category = existing.get("categoryId")
        if not isinstance(category, str) or not category:
            raise HelperError("Existing video category is unavailable; no metadata write performed.")
        mutable = {"categoryId", "tags", "defaultLanguage", "defaultAudioLanguage"}
        snippet = {key: copy.deepcopy(existing[key]) for key in mutable if key in existing}
        if "tags" in snippet and (not isinstance(snippet["tags"], list) or any(not isinstance(tag, str) for tag in snippet["tags"])):
            raise HelperError("Existing video tags were invalid; no metadata write performed.")
        if any(not isinstance(snippet[key], str) for key in {"defaultLanguage", "defaultAudioLanguage"} & snippet.keys()):
            raise HelperError("Existing video language metadata was invalid; no metadata write performed.")
        snippet.update(title=title, description=description)
        updated = self.request("videos", {"part": "snippet"}, {"id": broadcast_id, "snippet": snippet}, method="PUT")
        response_snippet = updated.get("snippet") if isinstance(updated, dict) else None
        if not isinstance(response_snippet, dict) or updated.get("id") != broadcast_id or response_snippet.get("channelId") != expected_channel_id or response_snippet.get("title") != title or response_snippet.get("description") != description:
            raise HelperError("Metadata write response identity/title/description was unverified; do not claim success or retry automatically.")
        for key in mutable & snippet.keys():
            # Empty tags may be omitted in a returned resource; both represent
            # the same empty list. Other preserved values must match exactly.
            returned = response_snippet.get(key, [] if key == "tags" else None)
            if returned != snippet[key]:
                raise HelperError("Metadata response changed or omitted a preserved snippet field; review before another write.")
        return updated

    def create_broadcast(self, body):
        return self.request("liveBroadcasts", {"part": "id,snippet,status,contentDetails"}, body)

    def bind_broadcast(self, broadcast_id, stream_id):
        return self.request("liveBroadcasts/bind", {"id": broadcast_id, "part": "id,snippet,status,contentDetails", "streamId": stream_id})


def discover_reusable_streams_for_channel(api, expected_channel_id):
    """Sanitized read-only discovery; no private stream-key files or writes."""
    return api.discover_reusable_streams_for_channel(expected_channel_id)
