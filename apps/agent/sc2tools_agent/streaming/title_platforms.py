"""Own-app Twitch/Kick title adapters; importing this module does nothing.

Authorization is a separate explicit system-browser action. Neither adapter
reads OBS tokens, platform application credentials, cookies, or stream keys.
The caller supplies its own app configuration, pinned user ID and token file.
Cloud metadata writes are disabled unless write_enabled=True is supplied.

Official contracts:
https://dev.twitch.tv/docs/api/reference/#modify-channel-information
https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/
https://dev.twitch.tv/docs/authentication/validate-tokens/
https://docs.kick.com/apis/channels
https://docs.kick.com/getting-started/generating-tokens-oauth2-flow

TikTok public scopes do not provide a LIVE title/start API. LIVE Studio's
supported Start/End LIVE hotkey or Stream Deck action remains user-triggered.
https://developers.tiktok.com/docs/en/tiktok-api-scopes
https://www.tiktok.com/live/studio/help/article/Best-practice/Use-a-Stream-Deck-to-trigger-commands-quickly
"""
from contextlib import contextmanager
import base64
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import threading
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import webbrowser

from . import secret_store


class TitleAdapterError(Exception):
    """Contains only a safe fixed message, never a response/URL/token/title."""


class _HTTPFailure(TitleAdapterError):
    def __init__(self, code, oauth_error=None):
        self.code, self.oauth_error = code, oauth_error
        super().__init__(f"Official platform operation failed with HTTP {code}; private response withheld.")


TWITCH_SCOPE = frozenset({"channel:manage:broadcast"})
KICK_SCOPE = frozenset({"channel:read", "channel:write"})
PROVENANCE = "own-shared-title-app-v1"
_ENDPOINTS = frozenset({
    ("id.twitch.tv", "/oauth2/device"), ("id.twitch.tv", "/oauth2/token"),
    ("id.twitch.tv", "/oauth2/validate"), ("api.twitch.tv", "/helix/channels"),
    ("id.kick.com", "/oauth/token"), ("id.kick.com", "/oauth/token/introspect"),
    ("api.kick.com", "/public/v1/channels"),
})
_OAUTH_ERRORS = frozenset({"authorization_pending", "slow_down", "access_denied", "expired_token"})
_LOCKS, _LOCKS_GUARD = {}, threading.Lock()


def validate_title(title):
    if not isinstance(title, str):
        raise TitleAdapterError("Use a title of 1–70 characters without control characters or angle brackets.")
    if any(unicodedata.category(c) == "Cc" or c in "<>" for c in title):
        raise TitleAdapterError("Use a title of 1–70 characters without control characters or angle brackets.")
    title = title.strip()
    if not 1 <= len(title) <= 70:
        raise TitleAdapterError("Use a title of 1–70 characters without control characters or angle brackets.")
    try:
        title.encode("utf-8")
    except UnicodeEncodeError:
        raise TitleAdapterError("The title must contain valid UTF-8 text.") from None
    return title


def _scopes(value):
    if isinstance(value, str):
        return set(value.split())
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return set(value)
    return set()


def _identity(value):
    # User IDs never go into request paths or public errors.
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or int(value) <= 0:
        raise TitleAdapterError("A pinned platform user ID is required.")
    return str(int(value))


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward an Authorization header to another host.


class OfficialHTTP:
    """Bounded official endpoints only; response and transport errors sanitized."""
    def __init__(self):
        self._opener = build_opener(_NoRedirect())

    def request(self, method, url, *, headers=None, body=None, form=None):
        try:
            split = urlsplit(url)
            allowed = split.scheme == "https" and not split.username and not split.password and not split.port and not split.fragment and (split.hostname, split.path) in _ENDPOINTS
        except (ValueError, TypeError):
            allowed = False
        if not allowed:
            raise TitleAdapterError("The request is outside the official title adapter endpoints.")
        if method not in {"GET", "POST", "PATCH"} or (body is not None and form is not None):
            raise TitleAdapterError("Unsupported official title adapter operation.")
        if method == "GET" and (body is not None or form is not None):
            raise TitleAdapterError("Read operations cannot carry a write body.")
        request_headers = dict(headers or {})
        data = None
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            data = json.dumps(body, ensure_ascii=True).encode("utf-8")
        elif form is not None:
            request_headers["Content-Type"] = "application/x-www-form-urlencoded"
            data = urlencode(form).encode("ascii")
        try:
            request = Request(url, data=data, headers=request_headers, method=method)
            with self._opener.open(request, timeout=15) as response:
                if response.status == 204:
                    return None
                encoded = response.read(1048577)
            if len(encoded) > 1048576:
                raise TitleAdapterError("Official response exceeded the bounded size.")
            result = json.loads(encoded)
            if not isinstance(result, dict):
                raise TitleAdapterError("Official response schema was incomplete.")
            return result
        except HTTPError as error:
            # Only documented device-flow states are retained, never free text.
            code = error.code
            oauth_error = None
            try:
                reply = json.loads(error.read(4096))
                candidate = reply.get("error") or reply.get("message")
                if candidate in _OAUTH_ERRORS:
                    oauth_error = candidate
            except Exception:
                pass
            raise _HTTPFailure(code, oauth_error) from None
        except TitleAdapterError:
            raise
        except Exception:
            raise TitleAdapterError("Official platform operation did not complete; private details withheld.") from None


def _call(transport, method, url, **kwargs):
    try:
        return transport.request(method, url, **kwargs)
    except TitleAdapterError:
        raise
    except Exception:
        raise TitleAdapterError("Official platform operation did not complete; private details withheld.") from None


def _validate_client(client, platform):
    if not isinstance(client, dict) or client.get("platform") != platform or client.get("ownership") != "own-app" or not isinstance(client.get("client_id"), str) or not client["client_id"].strip():
        raise TitleAdapterError("Configure this helper's own platform OAuth app before connecting.")
    if platform == "twitch" and client.get("client_type") != "public":
        raise TitleAdapterError("Twitch title control requires this helper's own public device-code client.")
    if platform == "kick":
        if not isinstance(client.get("client_secret"), str) or not client["client_secret"]:
            raise TitleAdapterError("Configure this helper's own Kick app credentials before connecting.")
        _kick_redirect(client.get("redirect_uri"))
    return copy.deepcopy(client)


def _kick_redirect(value):
    try:
        split = urlsplit(value)
        valid = split.scheme == "http" and split.hostname == "localhost" and not split.username and not split.password and not split.query and not split.fragment and split.path == "/oauth/kickcallback" and 1024 <= split.port <= 65535
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise TitleAdapterError("Register a localhost callback with an explicit local port and /oauth/kickcallback path.")
    return split.port


class AtomicTokenStore:
    """DPAPI-encrypted file with thread/process serialized refresh.

    The caller owns the private directory/ACL policy. No file is created until
    explicit authorization succeeds or an existing token is refreshed.
    A lock left after a crash fails closed; it is never silently stolen.
    """
    def __init__(self, path):
        self.path = Path(path).resolve()
        key = os.path.normcase(str(self.path))
        with _LOCKS_GUARD:
            self._lock = _LOCKS.setdefault(key, threading.RLock())
        self.lock_path = self.path.with_name(self.path.name + ".refresh-lock")

    @contextmanager
    def transaction(self):
        with self._lock:
            try:
                descriptor = os.open(self.lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except OSError:
                raise TitleAdapterError("The private credential store is busy or unavailable; retry after checking the connection.") from None
            try:
                os.close(descriptor)
                yield self
            finally:
                try:
                    self.lock_path.unlink()
                except OSError:
                    pass

    def load(self):
        try:
            data = secret_store.read_json(self.path)
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except Exception:
            raise TitleAdapterError("Own-app authorization is unavailable; explicitly connect this platform.") from None

    def save(self, data):
        try:
            secret_store.write_json(self.path, data)
        except Exception:
            raise TitleAdapterError("Private authorization could not be saved atomically; reconnect before further operations.") from None


class OwnAppCredentials:
    """Official validation pins client provenance, scope and expected account."""
    def __init__(self, platform, client, token_store, expected_user_id, *, transport=None, clock=time.time):
        self.platform = platform
        if platform not in {"twitch", "kick"}:
            raise TitleAdapterError("This platform does not provide a supported title adapter.")
        self.client = _validate_client(client, platform)
        self.expected_user_id = _identity(expected_user_id)
        self.store = token_store
        self.transport = transport or OfficialHTTP()
        self.clock = clock
        self._validated_fingerprint, self._validated_at = None, None

    @property
    def scopes(self):
        return TWITCH_SCOPE if self.platform == "twitch" else KICK_SCOPE

    def _check_record(self, record):
        if record.get("provenance") != PROVENANCE or record.get("platform") != self.platform or record.get("own_client_id") != self.client["client_id"] or record.get("expected_user_id") != self.expected_user_id or not self.scopes.issubset(_scopes(record.get("scope"))):
            raise TitleAdapterError("Authorization does not match this helper's own app, pinned account, and required scopes.")
        if not isinstance(record.get("access_token"), str) or not record["access_token"]:
            raise TitleAdapterError("Own-app access authorization is unavailable; reconnect this platform.")
        try:
            if not isinstance(record["expires_at"], (float, int)) or isinstance(record["expires_at"], bool) or not math.isfinite(record["expires_at"]):
                raise ValueError()
        except (KeyError, ValueError):
            raise TitleAdapterError("Authorization expiry was unavailable; reconnect this platform.") from None

    def _validate_official(self, token):
        if self.platform == "twitch":
            result = _call(self.transport, "GET", "https://id.twitch.tv/oauth2/validate", headers={"Authorization": "OAuth " + token})
            valid = isinstance(result, dict) and result.get("client_id") == self.client["client_id"] and str(result.get("user_id")) == self.expected_user_id and self.scopes.issubset(_scopes(result.get("scopes")))
        else:
            result = _call(self.transport, "POST", "https://id.kick.com/oauth/token/introspect", headers={"Authorization": "Bearer " + token})
            data = result.get("data") if isinstance(result, dict) else None
            valid = isinstance(data, dict) and data.get("active") is True and data.get("token_type") == "user" and data.get("client_id") == self.client["client_id"] and self.scopes.issubset(_scopes(data.get("scope")))
            # Kick introspection does not return user identity. Verify the
            # authenticated no-filter channel endpoint before issuing writes.
            if valid:
                channel = _own_channel(_call(self.transport, "GET", "https://api.kick.com/public/v1/channels", headers={"Authorization": "Bearer " + token}), self.expected_user_id)
                valid = bool(channel)
        if not valid:
            raise TitleAdapterError("Official authorization identity or scope differs from the pinned own-app connection.")

    def _refresh(self, record):
        refresh = record.get("refresh_token")
        if not isinstance(refresh, str) or not refresh:
            raise TitleAdapterError("Own-app refresh authorization is unavailable; explicitly reconnect.")
        form = {"grant_type": "refresh_token", "client_id": self.client["client_id"], "refresh_token": refresh}
        if self.platform == "kick":
            form["client_secret"] = self.client["client_secret"]
        url = "https://id.twitch.tv/oauth2/token" if self.platform == "twitch" else "https://id.kick.com/oauth/token"
        result = _call(self.transport, "POST", url, form=form)
        fresh = _token_record(result, self.platform, self.client["client_id"], self.expected_user_id, self.scopes, self.clock())
        self._validate_official(fresh["access_token"])
        self.store.save(fresh)  # Commit rotating refresh token before returning.
        return fresh

    def access_token(self):
        with self.store.transaction():
            record = self.store.load()
            self._check_record(record)
            if self.clock() >= record["expires_at"] - 60:
                record = self._refresh(record)
            fingerprint = hashlib.sha256(record["access_token"].encode()).digest()
            if self._validated_fingerprint != fingerprint or self._validated_at is None or not 0 <= self.clock() - self._validated_at < 3600:
                self._validate_official(record["access_token"])
                self._validated_fingerprint, self._validated_at = fingerprint, self.clock()
            return record["access_token"]


def _token_record(result, platform, client_id, expected_id, required_scopes, now):
    if not isinstance(result, dict) or not isinstance(result.get("access_token"), str) or not result["access_token"] or not isinstance(result.get("refresh_token"), str) or not result["refresh_token"] or not required_scopes.issubset(_scopes(result.get("scope"))):
        raise TitleAdapterError("OAuth did not supply the required own-app access, refresh authorization and scopes.")
    expiry = result.get("expires_in")
    if not isinstance(expiry, (int, float)) or isinstance(expiry, bool) or not math.isfinite(expiry) or not 60 < expiry < 31536000:
        raise TitleAdapterError("OAuth expiry was unavailable; reconnect this platform.")
    return {"access_token": result["access_token"], "refresh_token": result["refresh_token"],
            "scope": sorted(_scopes(result["scope"])), "expires_at": now + expiry,
            "provenance": PROVENANCE, "platform": platform, "own_client_id": client_id,
            "expected_user_id": expected_id}


def _own_channel(result, expected_user_id):
    rows = result.get("data") if isinstance(result, dict) else None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or str(rows[0].get("broadcaster_user_id")) != expected_user_id or not isinstance(rows[0].get("stream_title"), str):
        raise TitleAdapterError("Authenticated Kick channel identity or title could not be verified.")
    return rows[0]


def _login(value):
    if not isinstance(value, str):
        raise TitleAdapterError("The authorized platform account name could not be verified.")
    value = value.strip().lstrip("@").lower()
    if not 1 <= len(value) <= 50 or not value.isascii() or any(not (c.isalnum() or c in "_-") for c in value):
        raise TitleAdapterError("The authorized platform account name could not be verified.")
    return value


def _discover_authorized_account(platform, client, token, transport, expected_user_id=None, expected_login=None):
    """Select only the OAuth subject, never an arbitrary supplied channel."""
    if platform == "twitch":
        result = _call(transport, "GET", "https://id.twitch.tv/oauth2/validate", headers={"Authorization": "OAuth " + token})
        if not isinstance(result, dict) or result.get("client_id") != client["client_id"] or not TWITCH_SCOPE.issubset(_scopes(result.get("scopes"))):
            raise TitleAdapterError("Official authorization does not match this helper's own Twitch app and scope.")
        user_id, account = _identity(result.get("user_id")), _login(result.get("login"))
    else:
        result = _call(transport, "POST", "https://id.kick.com/oauth/token/introspect", headers={"Authorization": "Bearer " + token})
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, dict) or data.get("active") is not True or data.get("token_type") != "user" or data.get("client_id") != client["client_id"] or not KICK_SCOPE.issubset(_scopes(data.get("scope"))):
            raise TitleAdapterError("Official authorization does not match this helper's own Kick app and scopes.")
        result = _call(transport, "GET", "https://api.kick.com/public/v1/channels", headers={"Authorization": "Bearer " + token})
        rows = result.get("data") if isinstance(result, dict) else None
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise TitleAdapterError("The authorized Kick account could not be selected unambiguously.")
        user_id, account = _identity(rows[0].get("broadcaster_user_id")), _login(rows[0].get("slug"))
        _own_channel(result, user_id)
    if expected_user_id is not None and user_id != _identity(expected_user_id):
        raise TitleAdapterError("The authorized platform account differs from the selected account; no connection was saved.")
    if expected_login is not None and account != _login(expected_login):
        raise TitleAdapterError("The authorized platform account differs from the selected account; no connection was saved.")
    return user_id, account


class _TitleAdapter:
    platform = None

    def __init__(self, credentials=None, expected_user_id=None, *, write_enabled=False, transport=None):
        self.credentials, self.write_enabled = credentials, write_enabled is True
        self.expected_user_id = _identity(expected_user_id) if expected_user_id is not None else None
        if credentials is not None and (credentials.platform != self.platform or credentials.expected_user_id != self.expected_user_id):
            raise TitleAdapterError("Title adapter and own-app credentials must pin the same platform account.")
        self.transport = transport or (credentials.transport if credentials else OfficialHTTP())
        self._operation_lock = threading.RLock()

    def _headers(self):
        if self.credentials is None:
            raise TitleAdapterError("Explicitly connect this platform using this helper's own OAuth app.")
        token = self.credentials.access_token()
        headers = {"Authorization": "Bearer " + token}
        if self.platform == "twitch":
            headers["Client-Id"] = self.credentials.client["client_id"]
        return headers

    def public_status(self):
        if self.credentials is None:
            return {"platform": self.platform, "connected": False, "title": None, "reason": "Connect this platform using this helper's own OAuth app."}
        with self._operation_lock:
            try:
                title = self._read_title(self._headers())
                return {"platform": self.platform, "connected": True, "title": title, "reason": ""}
            except Exception:
                return {"platform": self.platform, "connected": False, "title": None, "reason": "The own-app platform connection could not be verified. Reconnect before applying titles."}

    def update_title(self, title):
        if not self.write_enabled:
            raise TitleAdapterError("Platform title writes were not explicitly enabled.")
        title = validate_title(title)
        with self._operation_lock:
            headers = self._headers()
            before = self._read_title(headers)  # Identity verification before PATCH.
            if before != title:
                self._write_title(headers, title)
            observed = self._read_title(headers)
            if observed != title:
                raise TitleAdapterError("The platform did not confirm the requested title. Check its current title before retrying.")
            return {"platform": self.platform, "connected": True, "title": observed, "reason": "", "updated": before != title}


class TwitchTitleAdapter(_TitleAdapter):
    platform = "twitch"

    def _url(self):
        return "https://api.twitch.tv/helix/channels?" + urlencode({"broadcaster_id": self.expected_user_id})

    def _read_title(self, headers):
        result = _call(self.transport, "GET", self._url(), headers=headers)
        rows = result.get("data") if isinstance(result, dict) else None
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or rows[0].get("broadcaster_id") != self.expected_user_id or not isinstance(rows[0].get("title"), str):
            raise TitleAdapterError("Pinned Twitch channel identity or title could not be verified.")
        return rows[0]["title"]

    def _write_title(self, headers, title):
        _call(self.transport, "PATCH", self._url(), headers=headers, body={"title": title})


class KickTitleAdapter(_TitleAdapter):
    platform = "kick"

    def _read_title(self, headers):
        result = _call(self.transport, "GET", "https://api.kick.com/public/v1/channels", headers=headers)
        return _own_channel(result, self.expected_user_id)["stream_title"]

    def _write_title(self, headers, title):
        _call(self.transport, "PATCH", "https://api.kick.com/public/v1/channels", headers=headers, body={"stream_title": title})


class TikTokManualTitleAdapter:
    def public_status(self):
        return {"platform": "tiktok", "connected": False, "title": None,
                "reason": "Set the title in TikTok LIVE Studio. Its supported Start/End LIVE hotkey or Stream Deck action can start the existing horizontal virtual-camera stream."}

    def update_title(self, title):
        validate_title(title)
        raise TitleAdapterError("TikTok's public API does not expose LIVE title control; use LIVE Studio.")


def authorize_twitch(client, token_store, expected_user_id=None, *, expected_login=None, explicit=False, transport=None,
                     opener=webbrowser.open, on_prompt=None, clock=time.time, monotonic=time.monotonic, sleep=time.sleep):
    """Own public-client DCF; only explicit user-driven calls open a browser."""
    if explicit is not True:
        raise TitleAdapterError("Explicit user authorization is required before connecting Twitch.")
    client = _validate_client(client, "twitch")
    expected_user_id = _identity(expected_user_id) if expected_user_id is not None else None
    transport = transport or OfficialHTTP()
    device = _call(transport, "POST", "https://id.twitch.tv/oauth2/device", form={"client_id": client["client_id"], "scopes": " ".join(sorted(TWITCH_SCOPE))})
    try:
        split = urlsplit(device["verification_uri"])
        valid = split.scheme == "https" and split.hostname == "www.twitch.tv" and split.path == "/activate" and not split.username and not split.password and not split.port and not split.fragment
        device_code = device["device_code"]
        user_code = device["user_code"]
        interval, expires = device["interval"], device["expires_in"]
        valid = valid and isinstance(device_code, str) and bool(device_code) and isinstance(user_code, str) and 4 <= len(user_code) <= 32 and user_code.isascii() and all(c.isalnum() or c == "-" for c in user_code) and isinstance(interval, int) and not isinstance(interval, bool) and 1 <= interval <= 30 and isinstance(expires, int) and not isinstance(expires, bool) and 30 <= expires <= 1800
    except Exception:
        valid = False
    if not valid:
        raise TitleAdapterError("Twitch device authorization response could not be verified.")
    if on_prompt is not None:
        try:
            # Transient UI only. Never deliver device_code, access/refresh
            # tokens or client credentials, and do not persist this prompt.
            on_prompt({"platform": "twitch", "user_code": user_code,
                       "verification_uri": device["verification_uri"]})
        except Exception:
            raise TitleAdapterError("The Twitch authorization code could not be displayed safely.") from None
    try:
        opened = opener(device["verification_uri"], new=1)
    except Exception:
        opened = False
    if not opened:
        raise TitleAdapterError("The system browser could not open Twitch authorization.")
    deadline = monotonic() + min(expires, 180)
    tokens = None
    while monotonic() + interval < deadline:
        sleep(interval)
        try:
            tokens = _call(transport, "POST", "https://id.twitch.tv/oauth2/token", form={"client_id": client["client_id"], "scopes": " ".join(sorted(TWITCH_SCOPE)), "device_code": device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
            break
        except _HTTPFailure as error:
            if error.oauth_error == "authorization_pending":
                continue
            if error.oauth_error == "slow_down":
                interval += 5
                continue
            raise TitleAdapterError("Twitch device authorization was denied or did not complete.") from None
    if tokens is None:
        raise TitleAdapterError("Twitch authorization did not complete within the bounded window.")
    record = _token_record(tokens, "twitch", client["client_id"], expected_user_id, TWITCH_SCOPE, clock())
    user_id, account = _discover_authorized_account("twitch", client, record["access_token"], transport, expected_user_id, expected_login)
    record["expected_user_id"] = user_id
    with token_store.transaction():
        token_store.save(record)
    return {"platform": "twitch", "connected": True, "user_id": user_id, "account": account, "reason": "Own-app authorization saved privately."}


def _kick_callback_code(path, host, redirect, state):
    """Pure callback validation; None is invalid, False is denied, str is code."""
    port = _kick_redirect(redirect)
    try:
        split = urlsplit(path)
        query = parse_qs(split.query)
        if split.scheme or split.netloc or split.fragment or split.path != "/oauth/kickcallback" or host != f"localhost:{port}" or query.get("state") != [state]:
            return None
        if query.get("error") or len(query.get("code", [])) != 1 or not query["code"][0]:
            return False
        return query["code"][0]
    except (ValueError, TypeError):
        return None


def _receive_kick_callback(redirect, state, authorization_url, opener, timeout):
    received = {}
    port = _kick_redirect(redirect)

    class BoundedServer(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(3)
            return connection, address

        def handle_error(self, *args):
            pass

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            result = _kick_callback_code(self.path, self.headers.get("Host"), redirect, state)
            if result is None:
                self.send_response(400)
                self.end_headers()
                return
            if result is False:
                received["denied"] = True
            else:
                received["code"] = result
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Authorization received. Return to the local stream dock.")

    try:
        with BoundedServer(("127.0.0.1", port), Callback) as server:
            server.timeout = 0.5
            if not opener(authorization_url, new=1):
                raise TitleAdapterError("The system browser could not open Kick authorization.")
            deadline = time.monotonic() + timeout
            while not received and time.monotonic() < deadline:
                server.handle_request()
    except TitleAdapterError:
        raise
    except Exception:
        raise TitleAdapterError("The local Kick authorization callback was unavailable; private details withheld.") from None
    if not received.get("code"):
        raise TitleAdapterError("Kick authorization was denied or did not complete within the bounded window.")
    return received["code"]


def authorize_kick(client, token_store, expected_user_id=None, *, expected_login=None, explicit=False, transport=None,
                   opener=webbrowser.open, callback_receiver=_receive_kick_callback, clock=time.time):
    """Own-app localhost authorization-code/PKCE flow; explicit browser consent."""
    if explicit is not True:
        raise TitleAdapterError("Explicit user authorization is required before connecting Kick.")
    client = _validate_client(client, "kick")
    expected_user_id = _identity(expected_user_id) if expected_user_id is not None else None
    transport = transport or OfficialHTTP()
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    state = secrets.token_urlsafe(32)
    authorization_url = "https://id.kick.com/oauth/authorize?" + urlencode({
        "client_id": client["client_id"], "response_type": "code", "redirect_uri": client["redirect_uri"],
        "state": state, "scope": " ".join(sorted(KICK_SCOPE)), "code_challenge": challenge, "code_challenge_method": "S256",
    })
    try:
        code = callback_receiver(client["redirect_uri"], state, authorization_url, opener, 180)
    except TitleAdapterError:
        raise
    except Exception:
        raise TitleAdapterError("Kick authorization callback did not complete; private details withheld.") from None
    if not isinstance(code, str) or not code:
        raise TitleAdapterError("Kick authorization did not return an authorization code.")
    tokens = _call(transport, "POST", "https://id.kick.com/oauth/token", form={
        "grant_type": "authorization_code", "client_id": client["client_id"], "client_secret": client["client_secret"],
        "redirect_uri": client["redirect_uri"], "code": code, "code_verifier": verifier,
    })
    record = _token_record(tokens, "kick", client["client_id"], expected_user_id, KICK_SCOPE, clock())
    user_id, account = _discover_authorized_account("kick", client, record["access_token"], transport, expected_user_id, expected_login)
    record["expected_user_id"] = user_id
    with token_store.transaction():
        token_store.save(record)
    return {"platform": "kick", "connected": True, "user_id": user_id, "account": account, "reason": "Own-app authorization saved privately."}


def _paths(platform, directory):
    if platform not in {"twitch", "kick"}:
        raise TitleAdapterError("This platform does not provide a supported title API.")
    directory = Path(directory)
    return directory / f"{platform}-title-client.dpapi", directory / f"{platform}-title-tokens.dpapi"


def _connect(platform, client, directory, *, explicit=False, expected_login=None, expected_user_id=None, **flow_options):
    if explicit is not True:
        raise TitleAdapterError("Explicit user authorization is required before connecting a platform.")
    # Reject invalid configuration before any persistence or browser launch.
    client = _validate_client(client, platform)
    config_path, token_path = _paths(platform, directory)
    try:
        token_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise TitleAdapterError("The private platform connection directory is unavailable.") from None
    authorize = authorize_twitch if platform == "twitch" else authorize_kick
    result = authorize(client, AtomicTokenStore(token_path), expected_user_id,
                       explicit=True, expected_login=expected_login, **flow_options)
    try:
        secret_store.write_json(config_path, {"client": client, "expected_user_id": result["user_id"], "expected_login": result["account"]})
    except Exception:
        raise TitleAdapterError("The platform app configuration could not be saved privately; reconnect before applying titles.") from None
    return result


def connect_twitch(client, directory, *, explicit=False, expected_login=None, expected_user_id=None, **flow_options):
    """Explicit Connect button action; persist encrypted own-app account pin.

    client={platform:'twitch', ownership:'own-app', client_type:'public',
            client_id:<SC2Tools own registered public client ID>}
    Optional flow_options are transport/opener/on_prompt/clock/monotonic/sleep, useful for
    tests and bounded off-GUI-thread authorization. No auth runs on import.
    on_prompt receives transient {platform,user_code,verification_uri}; show
    the user code while authorization is pending, never log or persist it.
    """
    return _connect("twitch", client, directory, explicit=explicit,
                    expected_login=expected_login, expected_user_id=expected_user_id, **flow_options)


def connect_kick(client, directory, *, explicit=False, expected_login=None, expected_user_id=None, **flow_options):
    """Explicit Connect button action; encrypted app secret/token persistence.

    client={platform:'kick', ownership:'own-app', client_id:<own ID>,
            client_secret:<own secret>,
            redirect_uri:'http://localhost:PORT/oauth/kickcallback'}
    Optional flow_options are transport/opener/callback_receiver/clock.
    """
    return _connect("kick", client, directory, explicit=explicit,
                    expected_login=expected_login, expected_user_id=expected_user_id, **flow_options)


def load_adapter(platform, directory, *, write_enabled=False, transport=None):
    """Reload encrypted credentials without starting auth or making requests.

    public_status() performs the subsequent supported identity/title checks.
    write_enabled remains a caller-controlled explicit gate after reloading.
    Missing or invalid connections return a disconnected adapter, not a
    fallback to OBS credentials or cookies. TikTok remains manual title entry.
    """
    if platform == "tiktok":
        return TikTokManualTitleAdapter()
    config_path, token_path = _paths(platform, directory)
    cls = TwitchTitleAdapter if platform == "twitch" else KickTitleAdapter
    try:
        config = secret_store.read_json(config_path)
        credentials = OwnAppCredentials(platform, config["client"], AtomicTokenStore(token_path),
                                        config["expected_user_id"], transport=transport)
        # Local provenance checking only; no network during agent startup.
        credentials._check_record(credentials.store.load())
        return cls(credentials, config["expected_user_id"], write_enabled=write_enabled, transport=transport)
    except Exception:
        return cls(write_enabled=write_enabled, transport=transport)
