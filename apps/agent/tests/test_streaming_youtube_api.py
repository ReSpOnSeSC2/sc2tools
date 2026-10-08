"""Network-free official API adapter tests; fake token/IDs, no OBS/auth calls."""

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from sc2tools_agent.streaming.common import HelperError
from sc2tools_agent.streaming.youtube_google_oauth import API, GoogleAPI
from sc2tools_agent.streaming import youtube_google_oauth as oauth

MODULE = "sc2tools_agent.streaming.youtube_google_oauth"


class Response:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return json.dumps(self.value).encode("utf-8")


def video():
    return {
        "id": "mock-event-horizontal",
        "snippet": {
            "channelId": "mock-channel", "title": "Previous title", "description": "Previous description",
            "categoryId": "20", "tags": ["StarCraft II", "Protoss"],
            "defaultLanguage": "en", "defaultAudioLanguage": "en-US",
            "publishedAt": "2026-10-08T00:00:00Z", "channelTitle": "Mock channel",
            "liveBroadcastContent": "live", "localized": {"title": "Previous title", "description": "Previous description"},
            "thumbnails": {"default": {"url": "https://example.invalid/thumbnail.png"}},
        },
        "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False},
    }


def broadcast(identifier, channel="mock-channel", status="live"):
    return {"id": identifier, "snippet": {"channelId": channel},
            "status": {"lifeCycleStatus": status}, "contentDetails": {"boundStreamId": "mock-key"}}


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.credentials = Mock()
        self.credentials.access_token.return_value = "mock-never-real-token"
        self.api = GoogleAPI(self.credentials, write_enabled=True)
        self.existing = video()
        self.requests = []
        self.replies = []
        self.transport = patch("sc2tools_agent.streaming.youtube_google_oauth.urlopen", side_effect=self.reply)
        self.transport.start()
        self.addCleanup(self.transport.stop)

    def reply(self, request, timeout):
        split = urlsplit(request.full_url)
        self.assertEqual(split.scheme, "https")
        self.assertEqual(split.netloc, "www.googleapis.com")
        self.assertEqual(timeout, 15)
        body = json.loads(request.data) if request.data is not None else None
        call = {"method": request.get_method(), "path": split.path, "params": parse_qs(split.query), "body": body}
        self.requests.append(call)
        if self.replies:
            value = self.replies.pop(0)
            if isinstance(value, Exception):
                raise value
            return Response(value)
        if call["method"] == "GET" and call["path"].endswith("/videos"):
            return Response({"items": [copy.deepcopy(self.existing)]})
        if call["method"] == "PUT" and call["path"].endswith("/videos"):
            return Response({"id": body["id"], "snippet": {**body["snippet"], "channelId": self.existing["snippet"]["channelId"]}})
        self.fail("Unexpected mocked transport operation; no real network is allowed.")

    def update(self, title="New title", description="New description"):
        return self.api.update_video_metadata("mock-event-horizontal", title, description, "mock-channel")

    def test_local_broadcast_insert_sends_gaming_category_in_documented_snippet(self):
        body = {"snippet": {"title": "Gaming broadcast", "description": "Description", "categoryId": "20", "scheduledStartTime": "2026-10-08T12:01:00Z"},
                "status": {"privacyStatus": "unlisted", "selfDeclaredMadeForKids": False},
                "contentDetails": {"enableAutoStart": True, "enableAutoStop": True, "monitorStream": {"enableMonitorStream": False}}}
        self.replies.append({"id": "mock-new-event", "snippet": {**body["snippet"], "channelId": "mock-channel"}})
        result = self.api.create_broadcast(body)
        self.assertEqual(self.requests[0]["method"], "POST")
        self.assertTrue(self.requests[0]["path"].endswith("/liveBroadcasts"))
        self.assertEqual(self.requests[0]["body"], body)
        self.assertEqual(result["snippet"]["categoryId"], "20")

    def test_http_errors_keep_only_safe_status_for_poll_backoff(self):
        self.replies.append(HTTPError("https://example.invalid/private", 429, "Private message", {}, None))
        with self.assertRaises(HelperError) as error:
            self.api.streams_by_ids(["mock-stream"])
        self.assertEqual(error.exception.http_status, 429)
        self.assertNotIn("private", str(error.exception).lower().replace("private response withheld", ""))

    def test_put_preserves_every_mutable_snippet_field_and_excludes_status(self):
        unchanged = copy.deepcopy(self.existing)
        result = self.update()
        self.assertEqual([call["method"] for call in self.requests], ["GET", "PUT"])
        self.assertEqual(self.requests[0]["params"], {"part": ["snippet"], "id": ["mock-event-horizontal"]})
        write = self.requests[1]
        self.assertEqual(write["params"], {"part": ["snippet"]})
        self.assertEqual(set(write["body"]), {"id", "snippet"})
        self.assertEqual(write["body"]["snippet"], {
            "title": "New title", "description": "New description", "categoryId": "20",
            "tags": ["StarCraft II", "Protoss"], "defaultLanguage": "en", "defaultAudioLanguage": "en-US",
        })
        self.assertNotIn("status", write["body"])
        self.assertNotIn("localizations", write["body"])
        self.assertNotIn("channelId", write["body"]["snippet"])
        self.assertEqual(self.existing, unchanged)
        self.assertEqual(result["snippet"]["title"], "New title")

    def test_absent_optional_fields_are_not_invented(self):
        for key in ("tags", "defaultLanguage", "defaultAudioLanguage"):
            del self.existing["snippet"][key]
        self.update()
        self.assertEqual(set(self.requests[1]["body"]["snippet"]), {"title", "description", "categoryId"})

    def test_valid_utf8_boundary_is_accepted_without_truncation(self):
        self.update(title="🎮" * 100, description="🎮" * 1250)
        self.assertEqual(len(self.requests[1]["body"]["snippet"]["description"].encode("utf-8")), 5000)

    def test_invalid_metadata_rejects_before_any_google_call(self):
        invalid = [
            ("", "ok"), ("   ", "ok"), ("x" * 101, "ok"), ("<title>", "ok"),
            ("ok", "x" * 5001), ("ok", "€" * 1667), ("ok", "description > limit"),
            ("ok", None), ("\ud800", "ok"), ("ok", "\ud800"),
        ]
        for title, description in invalid:
            with self.subTest(title_length=len(title) if isinstance(title, str) else None), self.assertRaises(HelperError):
                self.update(title, description)
        self.assertEqual(self.requests, [])
        self.credentials.access_token.assert_not_called()

    def test_write_gate_rejects_update_before_list_or_token(self):
        self.api.write_enabled = False
        with self.assertRaises(HelperError):
            self.update()
        self.assertEqual(self.requests, [])
        self.credentials.access_token.assert_not_called()

    def test_foreign_or_unexpected_video_is_never_updated(self):
        for field, value in (("channel", "foreign-channel"), ("id", "mock-other-video")):
            with self.subTest(field=field):
                self.existing = video()
                if field == "channel":
                    self.existing["snippet"]["channelId"] = value
                else:
                    self.existing["id"] = value
                self.requests.clear()
                with self.assertRaises(HelperError):
                    self.update()
                self.assertEqual([call["method"] for call in self.requests], ["GET"])

    def test_category_must_be_present_before_put(self):
        del self.existing["snippet"]["categoryId"]
        with self.assertRaises(HelperError):
            self.update()
        self.assertEqual([call["method"] for call in self.requests], ["GET"])

    def test_invalid_existing_optional_values_are_not_deleted_or_written(self):
        for key, value in (("tags", "not-a-list"), ("tags", [42]), ("defaultLanguage", None)):
            with self.subTest(key=key):
                self.existing = video()
                self.existing["snippet"][key] = value
                self.requests.clear()
                with self.assertRaises(HelperError):
                    self.update()
                self.assertEqual([call["method"] for call in self.requests], ["GET"])

    def test_unverified_response_is_not_success_and_is_not_retried(self):
        for change in ("id", "channelId", "title", "description", "categoryId", "tags", "defaultAudioLanguage"):
            with self.subTest(change=change):
                self.requests.clear()
                response = {"id": "mock-event-horizontal", "snippet": {
                    "channelId": "mock-channel", "title": "New title", "description": "New description",
                    "categoryId": "20", "tags": ["StarCraft II", "Protoss"], "defaultLanguage": "en", "defaultAudioLanguage": "en-US"}}
                if change == "id":
                    response["id"] = "mock-other-event"
                else:
                    response["snippet"][change] = "unexpected-value"
                self.replies = [{"items": [copy.deepcopy(self.existing)]}, response]
                with self.assertRaises(HelperError):
                    self.update()
                self.assertEqual([call["method"] for call in self.requests], ["GET", "PUT"])

    def test_http_failure_withholds_private_response_and_never_retries(self):
        self.replies = [{"items": [copy.deepcopy(self.existing)]}, HTTPError(API + "videos", 403, "private-response-do-not-print", {}, None)]
        with self.assertRaises(HelperError) as failure:
            self.update()
        self.assertNotIn("private-response-do-not-print", str(failure.exception))
        self.assertEqual([call["method"] for call in self.requests], ["GET", "PUT"])

    def test_explicit_method_cannot_bypass_gate_or_enable_other_operations(self):
        self.api.write_enabled = False
        for resource, method, body in (("videos", "PUT", {}), ("videos", "PUT", None), ("liveBroadcasts", "POST", {}), ("liveBroadcasts/bind", "POST", None)):
            with self.subTest(resource=resource), self.assertRaises(HelperError):
                self.api.request(resource, {"part": "snippet"}, body, method=method)
        self.api.write_enabled = True
        for resource, method, body in (("videos", "POST", {}), ("videos", "DELETE", None), ("liveBroadcasts", "PUT", {}), ("liveStreams", "POST", {}), ("videos", "GET", {})):
            with self.subTest(resource=resource, method=method), self.assertRaises(HelperError):
                self.api.request(resource, {}, body, method=method)
        self.assertEqual(self.requests, [])
        self.credentials.access_token.assert_not_called()


class BroadcastBatchTests(unittest.TestCase):
    def setUp(self):
        self.api = GoogleAPI(None)
        self.requests = []
        self.response = {"items": [broadcast("mock-portrait"), broadcast("mock-horizontal")]}
        def request(resource, params):
            self.requests.append((resource, params))
            return copy.deepcopy(self.response)
        self.api.request = request
        self.deny_network = patch("sc2tools_agent.streaming.youtube_google_oauth.urlopen", side_effect=AssertionError("Real network is forbidden"))
        self.deny_network.start()
        self.addCleanup(self.deny_network.stop)

    def test_exact_owned_schema_and_requested_order(self):
        rows = self.api.broadcasts_by_ids(["mock-horizontal", "mock-portrait"])
        self.assertEqual([row["id"] for row in rows], ["mock-horizontal", "mock-portrait"])
        self.assertEqual([row["snippet"]["channelId"] for row in rows], ["mock-channel", "mock-channel"])
        self.assertEqual(self.requests[0], ("liveBroadcasts", {"part": "id,snippet,status,contentDetails", "id": "mock-horizontal,mock-portrait", "maxResults": 50}))

    def test_missing_duplicate_unexpected_and_malformed_status_block(self):
        good = broadcast("mock-horizontal")
        for rows in ([], [good, good], [broadcast("mock-foreign")], [{**good, "status": {}}], [{**good, "contentDetails": None}], [{**good, "snippet": {}}]):
            with self.subTest(rows_count=len(rows)):
                self.response = {"items": rows}
                with self.assertRaises(HelperError):
                    self.api.broadcasts_by_ids(["mock-horizontal"])

    def test_invalid_inputs_do_not_call_adapter(self):
        for ids in ([], "mock-id", ["mock-id", "mock-id"], ["id1,id2"], [None], ["id" + str(i) for i in range(51)]):
            with self.subTest(count=len(ids)), self.assertRaises(HelperError):
                self.api.broadcasts_by_ids(ids)
        self.assertEqual(self.requests, [])


class OccupiedBroadcastTests(unittest.TestCase):
    def setUp(self):
        self.api = GoogleAPI(None)
        self.deny_network = patch("sc2tools_agent.streaming.youtube_google_oauth.urlopen", side_effect=AssertionError("Real network is forbidden"))
        self.deny_network.start()
        self.addCleanup(self.deny_network.stop)

    def test_separate_single_filters_pagination_and_dedup(self):
        calls = []
        def request(resource, params):
            calls.append((resource, copy.deepcopy(params)))
            status, page = params["broadcastStatus"], params.get("pageToken")
            if status == "active":
                return {"items": [broadcast("mock-shared")], "nextPageToken": "active-page-2"} if not page else {"items": [broadcast("mock-active-2")]}
            return {"items": [broadcast("mock-shared"), broadcast("mock-upcoming", status="ready")]}
        self.api.request = request
        rows = self.api.occupied_broadcasts()
        self.assertEqual([row["id"] for row in rows], ["mock-shared", "mock-active-2", "mock-upcoming"])
        self.assertEqual([call[1]["broadcastStatus"] for call in calls], ["active", "active", "upcoming"])
        for resource, params in calls:
            self.assertEqual(resource, "liveBroadcasts")
            self.assertEqual(params["broadcastType"], "all")
            self.assertNotIn("mine", params)
            self.assertNotIn("id", params)
        self.assertEqual(calls[1][1]["pageToken"], "active-page-2")
        self.assertNotIn("pageToken", calls[2][1])

    def test_upcoming_failure_cannot_return_only_active_snapshot(self):
        def request(resource, params):
            if params["broadcastStatus"] == "upcoming":
                raise TimeoutError("Mock uncertain discovery")
            return {"items": [broadcast("mock-active")]}
        self.api.request = request
        with self.assertRaises(TimeoutError):
            self.api.occupied_broadcasts()

    def test_bounded_active_pagination_never_returns_partial_conflict_list(self):
        self.api.request = lambda *args: {"items": [], "nextPageToken": "unbounded-history"}
        with self.assertRaises(HelperError):
            self.api.occupied_broadcasts()


class DesktopCredentialTests(unittest.TestCase):
    def setUp(self):
        temporary_root = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(dir=temporary_root)
        self.assertTrue(Path(self.temporary.name).resolve().is_relative_to(temporary_root))
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.client = {"installed": {"client_id": "mock-own.apps.googleusercontent.com", "client_secret": "mock-own-secret", "auth_uri": oauth.AUTH, "token_uri": oauth.TOKEN}}
        self.tokens = {"provenance": "own-desktop-client", "own_client_id": self.client["installed"]["client_id"], "scope": oauth.SCOPE,
                       "access_token": "mock-old-access", "refresh_token": "mock-old-refresh", "expires_at": 0}
        self.store = {self.directory / oauth.CLIENT_FILE: copy.deepcopy(self.client), self.directory / oauth.TOKEN_FILE: copy.deepcopy(self.tokens)}
        self.writes = []
        def read(path):
            return copy.deepcopy(self.store[Path(path)])
        def write(path, value):
            self.writes.append((Path(path), copy.deepcopy(value)))
            self.store[Path(path)] = copy.deepcopy(value)
        self.reader = patch(MODULE + ".read_json", side_effect=read)
        self.writer = patch(MODULE + ".write_json", side_effect=write)
        self.reader.start()
        self.writer.start()
        self.addCleanup(self.reader.stop)
        self.addCleanup(self.writer.stop)
        self.denied_network = patch(MODULE + ".urlopen", side_effect=AssertionError("Real network is forbidden"))
        self.denied_browser = patch(MODULE + ".webbrowser.open", side_effect=AssertionError("Real browser is forbidden"))
        self.denied_network.start()
        self.denied_browser.start()
        self.addCleanup(self.denied_network.stop)
        self.addCleanup(self.denied_browser.stop)

    def test_auth_and_import_default_are_noops_without_reading_files(self):
        with patch(MODULE + ".read_own_client", side_effect=AssertionError("Default must not read credentials")):
            self.assertFalse(oauth.authorize_desktop(self.directory)["authorization_started"])
            self.assertFalse(oauth.import_desktop_client(self.directory / "missing.json", self.directory)["credentials_changed"])
        self.assertEqual(self.writes, [])

    def test_explicit_client_import_validates_then_uses_encrypted_store(self):
        source = self.directory / "selected-client.json"
        source.write_text(json.dumps(self.client), encoding="utf-8")
        result = oauth.import_desktop_client(source, self.directory, explicit=True)
        self.assertTrue(result["credentials_changed"])
        self.assertEqual(self.writes, [(self.directory / oauth.CLIENT_FILE, self.client)])
        self.assertNotIn("mock-own-secret", json.dumps(result))
        self.assertFalse((self.directory / oauth.CLIENT_FILE).exists())  # Fake encrypted store; never plaintext copy.

    def test_web_client_or_non_google_endpoint_is_rejected_before_storage(self):
        source = self.directory / "bad-client.json"
        for config in ({"web": self.client["installed"]}, {"installed": {**self.client["installed"], "token_uri": "https://example.invalid/token"}}):
            source.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaises(HelperError):
                oauth.import_desktop_client(source, self.directory, explicit=True)
        self.assertEqual(self.writes, [])

    def test_runtime_directory_is_mandatory_and_absolute(self):
        for directory in (None, "", "relative-directory"):
            with self.assertRaises(HelperError):
                oauth.OwnDesktopCredentials(directory)

    def test_token_provenance_must_match_own_client(self):
        self.store[self.directory / oauth.TOKEN_FILE]["own_client_id"] = "mock-foreign-client"
        with self.assertRaises(HelperError):
            oauth.OwnDesktopCredentials(self.directory)

    def test_refresh_is_serialized_and_persisted_before_in_memory_assignment(self):
        credentials = oauth.OwnDesktopCredentials(self.directory)
        candidate = {"access_token": "mock-new-access", "expires_in": 3600}
        original_writer = oauth.write_json
        def assert_persist_first(path, value):
            self.assertEqual(credentials.tokens["access_token"], "mock-old-access")
            self.assertEqual(value["access_token"], "mock-new-access")
            original_writer(path, value)
        with patch(MODULE + ".token_post", return_value=candidate) as token_post, patch(MODULE + ".write_json", side_effect=assert_persist_first):
            with ThreadPoolExecutor(max_workers=4) as pool:
                returned = list(pool.map(lambda _: credentials.access_token(), range(12)))
        self.assertEqual(returned, ["mock-new-access"] * 12)
        token_post.assert_called_once()
        self.assertEqual(credentials.tokens["refresh_token"], "mock-old-refresh")
        self.assertEqual(self.store[self.directory / oauth.TOKEN_FILE]["access_token"], "mock-new-access")

    def test_refresh_storage_failure_keeps_old_disk_and_memory(self):
        credentials = oauth.OwnDesktopCredentials(self.directory)
        before = copy.deepcopy(credentials.tokens)
        with patch(MODULE + ".token_post", return_value={"access_token": "mock-new-access", "expires_in": 3600}), patch(MODULE + ".write_json", side_effect=OSError("private-path-do-not-print")):
            with self.assertRaises(HelperError) as failure:
                credentials.access_token()
        self.assertEqual(credentials.tokens, before)
        self.assertEqual(self.store[self.directory / oauth.TOKEN_FILE], before)
        self.assertNotIn("private-path-do-not-print", str(failure.exception))


class SanitizedDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.api = GoogleAPI(None)
        self.channel = {"id": "mock-channel", "snippet": {"title": "Mock channel"}}
        self.stream = {"id": "mock-stream", "snippet": {"channelId": "mock-channel", "title": "Existing reusable stream"},
                       "status": {"streamStatus": "inactive"}, "cdn": {"ingestionInfo": {"streamName": "mock-private-key", "ingestionAddress": "mock-private-ingest"}}}
        self.calls = []
        def request(resource, params):
            self.calls.append((resource, copy.deepcopy(params)))
            return {"items": [copy.deepcopy(self.channel if resource == "channels" else self.stream)]}
        self.api.request = request
        self.deny_network = patch(MODULE + ".urlopen", side_effect=AssertionError("Real network is forbidden"))
        self.deny_network.start()
        self.addCleanup(self.deny_network.stop)

    def test_owned_channel_requires_one_unambiguous_identity(self):
        self.assertEqual(self.api.owned_channel(), {"id": "mock-channel", "title": "Mock channel"})
        self.assertEqual(self.calls, [("channels", {"part": "snippet", "mine": "true", "maxResults": 50})])
        for result in ({"items": []}, {"items": [self.channel, self.channel]}, {"items": [self.channel], "nextPageToken": "ambiguous"}):
            self.api.request = lambda *args, result=result: result
            with self.assertRaises(HelperError):
                self.api.owned_channel()

    def test_mine_contract_discovery_is_reusable_only_and_returns_no_secrets(self):
        choices = self.api.discover_reusable_streams_for_channel("mock-channel")
        self.assertEqual(choices, [{"id": "mock-stream", "title": "Existing reusable stream", "channel": "mock-channel"}])
        self.assertNotIn("mock-private-key", json.dumps(choices))
        self.assertNotIn("cdn", json.dumps(choices))
        self.assertEqual(self.calls[1][1]["mine"], "true")
        self.assertNotIn("id", self.calls[1][1])
        self.assertNotIn("contentDetails", self.calls[1][1]["part"])

    def test_foreign_channel_and_explicit_nonreusable_stream_are_rejected(self):
        with self.assertRaises(HelperError):
            self.api.discover_reusable_streams_for_channel("foreign-channel")
        self.stream["contentDetails"] = {"isReusable": False}
        with self.assertRaises(HelperError):
            self.api.discover_reusable_streams_for_channel("mock-channel")

    def test_channels_is_read_only_in_adapter(self):
        api = GoogleAPI(None, write_enabled=True)
        with self.assertRaises(HelperError):
            api.request("channels", {}, {}, method="PUT")

    def test_changed_binding_on_duplicate_id_is_unknown(self):
        def request(resource, params):
            row = broadcast("mock-shared")
            if params["broadcastStatus"] == "upcoming":
                row["contentDetails"]["boundStreamId"] = "changed-key"
            return {"items": [row]}
        self.api.request = request
        with self.assertRaises(HelperError):
            self.api.occupied_broadcasts()


if __name__ == "__main__":
    unittest.main()
