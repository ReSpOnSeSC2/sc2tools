"""SC2Tools account transport; provider credentials stay on the server.

Writes make one bounded attempt. YouTube creation also carries the operation
ID durably saved by PairBackend before any cloud request.
"""
from __future__ import annotations

from urllib.parse import urlparse

import requests


class CloudStreamError(ValueError):
    def __init__(self, message, *, http_status=None):
        super().__init__(message)
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None


class CloudStreamingClient:
    def __init__(self, connection_provider, *, transport=None):
        self.connection_provider = connection_provider
        self.transport = transport or requests.request

    def _request(self, method, path, *, params=None, body=None):
        base, token = self.connection_provider()
        if not token:
            raise CloudStreamError("Pair this agent with your SC2Tools account first.")
        parsed = urlparse(base)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise CloudStreamError("Use a secure SC2Tools API connection.")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
            raise CloudStreamError("The SC2Tools API address is invalid.")
        try:
            response = self.transport(method, base.rstrip("/") + path,
                headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
                params=params, json=body, timeout=(5, 25), allow_redirects=False)
            if response.status_code == 404:
                raise CloudStreamError("Stream controls are not available on this SC2Tools server yet.", http_status=404)
            if response.status_code in {401, 403}:
                raise CloudStreamError("Connect your streaming account and approve stream-control permission in your browser.", http_status=response.status_code)
            if response.status_code == 409:
                raise CloudStreamError("This session needs recovery or another stream request is still running. Existing broadcasts are preserved.", http_status=409)
            if response.status_code == 429:
                raise CloudStreamError("Streaming request limit reached. Existing sessions are preserved; wait before checking again.", http_status=429)
            if not 200 <= response.status_code < 300:
                raise CloudStreamError("SC2Tools could not verify the stream request. Check the session before trying again.", http_status=response.status_code)
            result = response.json()
            if not isinstance(result, (dict, list)):
                raise CloudStreamError("SC2Tools returned incomplete stream information.")
            return result
        except CloudStreamError:
            raise
        except Exception:
            raise CloudStreamError("The stream request could not be verified. Existing broadcasts are preserved; recover before preparing again.") from None

    def statuses(self):
        result = self._request("GET", "/v1/agent/streaming/status")
        rows = result.get("platforms") if isinstance(result, dict) else None
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise CloudStreamError("SC2Tools returned incomplete account information.")
        return {row["platform"]: row for row in rows if row.get("platform") in {"youtube", "twitch", "kick"}}

    def connect(self, platform):
        if platform not in {"youtube", "twitch", "kick"}:
            raise CloudStreamError("This account connection is unavailable.")
        result = self._request("POST", "/v1/agent/streaming/" + platform + "/connect", body={})
        url = result.get("authorizeUrl", "") if isinstance(result, dict) else ""
        expected = {"youtube": ("accounts.google.com", "/o/oauth2/v2/auth"),
                    "twitch": ("id.twitch.tv", "/oauth2/authorize"),
                    "kick": ("id.kick.com", "/oauth/authorize")}[platform]
        try:
            parsed = urlparse(url)
            valid = parsed.scheme == "https" and (parsed.hostname, parsed.path) == expected and not parsed.username and not parsed.password and parsed.port in {None, 443}
        except Exception:
            valid = False
        if not valid:
            raise CloudStreamError("SC2Tools did not return the expected official account authorization page.")
        return url

    def update_title(self, platform, title):
        result = self._request("POST", "/v1/agent/streaming/title", body={"title": title, "platforms": [platform]})
        rows = result.get("platforms", []) if isinstance(result, dict) else []
        matches = [row for row in rows if isinstance(row, dict) and row.get("platform") == platform]
        if len(matches) != 1 or matches[0].get("streamingReady") is not True or matches[0].get("title") != title:
            raise CloudStreamError("The platform title was not verified. Check its connection.")
        return {**matches[0], "connected": matches[0].get("streamingReady") is True}


class CloudTitleAdapter:
    def __init__(self, client, platform):
        self.client, self.platform = client, platform

    def update_title(self, title):
        return self.client.update_title(self.platform, title)


class CloudGoogleAPI:
    write_enabled = True
    requires_operation_id = True

    def __init__(self, client, expected_channel_provider):
        self.client = client
        self.expected_channel_provider = expected_channel_provider

    def _expected_channel(self):
        identity = self.expected_channel_provider()
        if not isinstance(identity, str) or not identity:
            raise CloudStreamError("Choose the YouTube channel and both reusable keys first.")
        return identity

    def _catalog(self):
        value = self.client._request("GET", "/v1/streaming/youtube/catalog")
        if not isinstance(value, dict) or not isinstance(value.get("channel"), dict) or not isinstance(value.get("streams"), list):
            raise CloudStreamError("YouTube channel and reusable keys could not be verified.")
        return value

    def owned_channel(self):
        return self._catalog()["channel"]

    def discover_reusable_streams_for_channel(self, expected_channel_id):
        value = self._catalog()
        if value["channel"].get("id") != expected_channel_id:
            raise CloudStreamError("The connected YouTube channel changed. Recheck your channel and keys.")
        return value["streams"]

    def _read(self, operation, ids=None):
        params = {"operation": operation}
        if ids is not None:
            params["ids"] = ",".join(ids)
        value = self.client._request("GET", "/v1/streaming/youtube/read", params=params)
        rows = value.get("items") if isinstance(value, dict) else value
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise CloudStreamError("YouTube session information was incomplete.")
        return rows

    def streams_by_ids(self, ids):
        return self._read("streams_by_ids", ids)

    def broadcasts_by_ids(self, ids):
        return self._read("broadcasts_by_ids", ids)

    def broadcast_by_id(self, identity):
        rows = self.broadcasts_by_ids([identity])
        if len(rows) != 1 or rows[0].get("id") != identity:
            raise CloudStreamError("The owned YouTube broadcast could not be verified.")
        return rows[0]

    def occupied_broadcasts(self):
        return self._read("occupied_broadcasts")

    def all_owned_broadcasts(self):
        return self._read("all_owned_broadcasts")

    def recover_create(self, operation_id):
        value = self.client._request("GET", "/v1/streaming/youtube/read", params={
            "operation": "recover_create", "operation_id": operation_id,
        })
        if not isinstance(value, dict) or not value.get("id"):
            raise CloudStreamError("The previous YouTube creation could not be recovered. It has not been repeated.")
        return value

    def create_broadcast(self, body, *, operation_id):
        return self.client._request("POST", "/v1/streaming/youtube/create", body={
            "operation_id": operation_id, "expected_channel_id": self._expected_channel(), "body": body,
        })

    def bind_broadcast(self, broadcast_id, stream_id):
        return self.client._request("POST", "/v1/streaming/youtube/bind", body={
            "broadcast_id": broadcast_id, "stream_id": stream_id, "expected_channel_id": self._expected_channel(),
        })

    def update_video_metadata(self, broadcast_id, title, description, expected_channel_id):
        return self.client._request("POST", "/v1/streaming/youtube/metadata", body={
            "broadcast_id": broadcast_id, "title": title, "description": description,
            "expected_channel_id": expected_channel_id,
        })
