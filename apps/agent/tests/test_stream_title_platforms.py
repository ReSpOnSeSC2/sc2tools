"""Network-free own-app title contract, OAuth boundary and rotation tests.

All identities, clients, secrets and tokens are synthetic fixtures. External
network and browser launch are globally forbidden, including accidental calls.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from sc2tools_agent.streaming import title_platforms as subject


def client(platform):
    value = {"platform": platform, "ownership": "own-app", "client_id": "fixture-own-" + platform}
    if platform == "twitch":
        value["client_type"] = "public"
    else:
        value.update(client_secret="fixture-kick-secret", redirect_uri="http://localhost:18766/oauth/kickcallback")
    return value


def record(platform, now=1000, expires_at=5000):
    required = subject.TWITCH_SCOPE if platform == "twitch" else subject.KICK_SCOPE
    return {"access_token": "fixture-access", "refresh_token": "fixture-refresh",
            "scope": sorted(required), "expires_at": expires_at,
            "provenance": subject.PROVENANCE, "platform": platform,
            "own_client_id": client(platform)["client_id"], "expected_user_id": "123"}


class FakeTransport:
    def __init__(self, platform):
        self.platform, self.calls = platform, []
        self.user_id, self.client_id = "123", client(platform)["client_id"]
        self.title = "Old title"
        self.other = {"category": {"id": 20, "name": "StarCraft II"}, "tags": ["Protoss"], "description": "Keep description"}
        self.patch_error, self.ignore_patch, self.readback_foreign = None, False, False
        self.refresh_count, self.token_reply = 0, None
        self.scope_override, self.token_type, self.active = None, "user", True
        self.lock = threading.Lock()

    def request(self, method, url, **kwargs):
        with self.lock:
            self.calls.append((method, url, copy.deepcopy(kwargs)))
            path = urlsplit(url).path
            scopes = self.scope_override if self.scope_override is not None else sorted(subject.TWITCH_SCOPE if self.platform == "twitch" else subject.KICK_SCOPE)
            if path == "/oauth2/validate":
                return {"client_id": self.client_id, "user_id": self.user_id, "login": "fixture_account", "scopes": scopes, "expires_in": 4000}
            if path == "/oauth/token/introspect":
                return {"data": {"active": self.active, "client_id": self.client_id, "token_type": self.token_type, "scope": " ".join(scopes)}}
            if path in {"/oauth2/token", "/oauth/token"}:
                if kwargs.get("form", {}).get("grant_type") == "refresh_token":
                    self.refresh_count += 1
                return self.token_reply or {"access_token": "fixture-new-access", "refresh_token": "fixture-new-refresh", "scope": scopes, "expires_in": 4000}
            if path in {"/helix/channels", "/public/v1/channels"}:
                if method == "PATCH":
                    if self.patch_error:
                        raise self.patch_error
                    if not self.ignore_patch:
                        self.title = kwargs["body"]["title" if self.platform == "twitch" else "stream_title"]
                    return None
                identity = "999" if self.readback_foreign and any(c[0] == "PATCH" for c in self.calls) else self.user_id
                row = copy.deepcopy(self.other)
                if self.platform == "twitch":
                    row.update(broadcaster_id=identity, title=self.title)
                else:
                    row.update(broadcaster_user_id=int(identity), slug="fixture_account", stream_title=self.title)
                return {"data": [row]}
            raise AssertionError("Unexpected fixture request; never falls through to network.")


class NetworkFreeTest(unittest.TestCase):
    def setUp(self):
        network = patch("socket.socket.connect", side_effect=AssertionError("External network forbidden"))
        browser = patch("webbrowser.open", side_effect=AssertionError("System browser forbidden"))
        network.start()
        browser.start()
        self.addCleanup(network.stop)
        self.addCleanup(browser.stop)
        # Synthetic fixtures use an identity codec; production calls DPAPI.
        codec = patch.object(subject.secret_store, "_protect", side_effect=lambda data, **kwargs: data)
        codec.start()
        self.addCleanup(codec.stop)
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent, prefix="title-adapter-fixture-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "fixture.tokens.private.json"

    def credentials(self, platform, transport=None, value=None, clock=lambda: 1000):
        store = subject.AtomicTokenStore(self.path)
        with store.transaction():
            store.save(value or record(platform))
        return subject.OwnAppCredentials(platform, client(platform), store, "123", transport=transport or FakeTransport(platform), clock=clock)

    def adapter(self, platform, transport=None, write_enabled=True):
        transport = transport or FakeTransport(platform)
        cls = subject.TwitchTitleAdapter if platform == "twitch" else subject.KickTitleAdapter
        return cls(self.credentials(platform, transport), "123", write_enabled=write_enabled), transport


class TitleOperationTests(NetworkFreeTest):
    def test_both_platforms_patch_only_title_preserving_all_other_metadata(self):
        for platform in ("twitch", "kick"):
            with self.subTest(platform=platform):
                adapter, transport = self.adapter(platform)
                before = copy.deepcopy(transport.other)
                result = adapter.update_title(" New title 🎮 ")
                writes = [call for call in transport.calls if call[0] == "PATCH"]
                self.assertEqual(len(writes), 1)
                self.assertEqual(writes[0][2]["body"], {"title" if platform == "twitch" else "stream_title": "New title 🎮"})
                self.assertEqual(transport.other, before)
                self.assertEqual(result["title"], "New title 🎮")
                self.assertTrue(result["updated"])
                self.assertTrue(result["connected"])
                self.assertEqual(transport.calls[-1][0], "GET")
                if platform == "twitch":
                    self.assertEqual(parse_qs(urlsplit(writes[0][1]).query), {"broadcaster_id": ["123"]})
                    self.assertEqual(writes[0][2]["headers"]["Client-Id"], client(platform)["client_id"])
                else:
                    self.assertEqual(urlsplit(writes[0][1]).query, "")

    def test_write_disabled_rejects_before_any_token_read_or_network(self):
        for platform in ("twitch", "kick"):
            adapter, transport = self.adapter(platform, write_enabled=False)
            with self.assertRaises(subject.TitleAdapterError):
                adapter.update_title("New title")
            self.assertEqual(transport.calls, [])

    def test_invalid_titles_never_contact_platform(self):
        adapter, transport = self.adapter("twitch")
        for invalid in (None, "", "  ", "x" * 71, "newline\n", "\nleading", "<tag>", "a\x7fb", "a\x85b", "\ud800"):
            with self.subTest(kind=type(invalid).__name__), self.assertRaises(subject.TitleAdapterError):
                adapter.update_title(invalid)
        self.assertEqual(transport.calls, [])

    def test_utf8_seventy_character_title_is_preserved(self):
        adapter, _ = self.adapter("twitch")
        self.assertEqual(adapter.update_title("🎮" * 70)["title"], "🎮" * 70)

    def test_unchanged_title_avoids_redundant_write(self):
        adapter, transport = self.adapter("kick")
        result = adapter.update_title("Old title")
        self.assertFalse(result["updated"])
        self.assertFalse(any(method == "PATCH" for method, _, _ in transport.calls))

    def test_foreign_authorized_account_never_receives_patch(self):
        for platform in ("twitch", "kick"):
            adapter, transport = self.adapter(platform)
            transport.user_id = "999"
            with self.assertRaises(subject.TitleAdapterError):
                adapter.update_title("New title")
            self.assertFalse(any(method == "PATCH" for method, _, _ in transport.calls))

    def test_mismatched_app_or_missing_scope_never_receives_patch(self):
        for platform in ("twitch", "kick"):
            for mismatch in ("client", "scope"):
                adapter, transport = self.adapter(platform)
                if mismatch == "client":
                    transport.client_id = "fixture-borrowed-client"
                else:
                    transport.scope_override = []
                with self.assertRaises(subject.TitleAdapterError):
                    adapter.update_title("New title")
                self.assertFalse(any(method == "PATCH" for method, _, _ in transport.calls))

    def test_uncertain_write_or_incorrect_readback_is_never_retried(self):
        for case in ("exception", "ignored", "foreign"):
            adapter, transport = self.adapter("kick")
            if case == "exception":
                transport.patch_error = RuntimeError("fixture-private-response-secret-title-url")
            elif case == "ignored":
                transport.ignore_patch = True
            else:
                transport.readback_foreign = True
            with self.assertRaises(subject.TitleAdapterError) as caught:
                adapter.update_title("New title")
            self.assertNotIn("fixture-private-response", str(caught.exception))
            self.assertEqual(sum(method == "PATCH" for method, _, _ in transport.calls), 1)

    def test_public_status_returns_only_safe_schema_and_verified_title(self):
        adapter, transport = self.adapter("twitch")
        result = adapter.public_status()
        self.assertEqual(set(result), {"platform", "connected", "title", "reason"})
        self.assertEqual(result["title"], "Old title")
        transport.user_id = "999"
        # Reset hourly cache to force authorization validation as at startup.
        adapter.credentials._validated_at = None
        result = adapter.public_status()
        self.assertFalse(result["connected"])
        self.assertIsNone(result["title"])
        self.assertNotIn("fixture-access", json.dumps(result))

    def test_disconnected_adapters_do_not_create_files_or_make_calls(self):
        transport = Mock()
        for cls in (subject.TwitchTitleAdapter, subject.KickTitleAdapter):
            adapter = cls(transport=transport)
            self.assertFalse(adapter.public_status()["connected"])
        transport.request.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_mismatched_adapter_pin_is_rejected(self):
        credentials = self.credentials("twitch")
        with self.assertRaises(subject.TitleAdapterError):
            subject.TwitchTitleAdapter(credentials, "999")
        with self.assertRaises(subject.TitleAdapterError):
            subject.KickTitleAdapter(credentials, "123")

    def test_tiktok_has_no_automatic_title_or_start_api(self):
        adapter = subject.TikTokManualTitleAdapter()
        status = adapter.public_status()
        self.assertFalse(status["connected"])
        self.assertIn("LIVE Studio", status["reason"])
        self.assertIn("Stream Deck", status["reason"])
        with self.assertRaises(subject.TitleAdapterError):
            adapter.update_title("New title")


class CredentialTests(NetworkFreeTest):
    def test_private_record_provenance_pin_and_scope_are_enforced_before_network(self):
        for field, value in (("provenance", "obs-token"), ("own_client_id", "foreign-app"),
                             ("expected_user_id", "999"), ("platform", "kick"), ("scope", []),
                             ("expires_at", float("nan")), ("expires_at", float("inf"))):
            transport = FakeTransport("twitch")
            changed = record("twitch")
            changed[field] = value
            credentials = self.credentials("twitch", transport, changed)
            with self.assertRaises(subject.TitleAdapterError):
                credentials.access_token()
            self.assertEqual(transport.calls, [])

    def test_startup_and_hourly_validation(self):
        now = [1000]
        transport = FakeTransport("twitch")
        credentials = self.credentials("twitch", transport, record("twitch", expires_at=12000), clock=lambda: now[0])
        credentials.access_token()
        credentials.access_token()
        self.assertEqual(len(transport.calls), 1)
        now[0] = 4600
        credentials.access_token()
        self.assertEqual(len(transport.calls), 2)
        now[0] = 4500  # Clock moved backward: revalidate, never skip indefinitely.
        credentials.access_token()
        self.assertEqual(len(transport.calls), 3)

    def test_two_credentials_share_atomic_refresh_and_rotated_token(self):
        transport = FakeTransport("twitch")
        first = self.credentials("twitch", transport, record("twitch", expires_at=1000))
        second = subject.OwnAppCredentials("twitch", client("twitch"), subject.AtomicTokenStore(self.path), "123", transport=transport, clock=lambda: 1000)
        barrier = threading.Barrier(2)
        def access(credentials):
            barrier.wait(timeout=3)
            return credentials.access_token()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(access, c) for c in (first, second)]
            self.assertEqual([future.result(timeout=3) for future in futures], ["fixture-new-access", "fixture-new-access"])
        self.assertEqual(transport.refresh_count, 1)
        persisted = subject.secret_store.read_json(self.path)
        self.assertEqual(persisted["refresh_token"], "fixture-new-refresh")
        self.assertFalse(first.store.lock_path.exists())
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_refresh_never_borrows_client_secret_for_twitch_and_uses_own_kick_secret(self):
        for platform in ("twitch", "kick"):
            transport = FakeTransport(platform)
            credentials = self.credentials(platform, transport, record(platform, expires_at=1000))
            credentials.access_token()
            refresh = next(kwargs["form"] for _, _, kwargs in transport.calls if kwargs.get("form", {}).get("grant_type") == "refresh_token")
            self.assertEqual(refresh["client_id"], client(platform)["client_id"])
            self.assertEqual(refresh["refresh_token"], "fixture-refresh")
            if platform == "twitch":
                self.assertNotIn("client_secret", refresh)
            else:
                self.assertEqual(refresh["client_secret"], "fixture-kick-secret")

    def test_malformed_refresh_is_not_committed(self):
        transport = FakeTransport("twitch")
        credentials = self.credentials("twitch", transport, record("twitch", expires_at=1000))
        before = self.path.read_text()
        transport.token_reply = {"access_token": "fixture-new-access", "refresh_token": "fixture-new-refresh", "scope": [], "expires_in": 4000}
        with self.assertRaises(subject.TitleAdapterError):
            credentials.access_token()
        self.assertEqual(self.path.read_text(), before)
        self.assertEqual(transport.refresh_count, 1)

    def test_failed_atomic_save_never_returns_uncommitted_access_token(self):
        transport = FakeTransport("twitch")
        credentials = self.credentials("twitch", transport, record("twitch", expires_at=1000))
        with patch.object(subject.os, "replace", side_effect=OSError("fixture-private-path")):
            with self.assertRaises(subject.TitleAdapterError) as caught:
                credentials.access_token()
        self.assertNotIn("fixture-private-path", str(caught.exception))
        self.assertEqual(subject.secret_store.read_json(self.path)["access_token"], "fixture-access")
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_stale_process_lock_fails_closed_without_network(self):
        transport = FakeTransport("twitch")
        credentials = self.credentials("twitch", transport)
        credentials.store.lock_path.write_text("fixture-stale-lock")
        with self.assertRaises(subject.TitleAdapterError):
            credentials.access_token()
        self.assertEqual(transport.calls, [])
        self.assertEqual(credentials.store.lock_path.read_text(), "fixture-stale-lock")


class OAuthTests(NetworkFreeTest):
    def test_auth_without_explicit_true_has_no_network_browser_or_persistence(self):
        transport, opener, receiver = Mock(), Mock(), Mock()
        store = subject.AtomicTokenStore(self.path)
        for platform, fn in (("twitch", subject.authorize_twitch), ("kick", subject.authorize_kick)):
            for flag in (False, None, 1, "yes"):
                kwargs = {"explicit": flag, "transport": transport, "opener": opener}
                if platform == "kick":
                    kwargs["callback_receiver"] = receiver
                with self.assertRaises(subject.TitleAdapterError):
                    fn(client(platform), store, "123", **kwargs)
        transport.request.assert_not_called()
        opener.assert_not_called()
        receiver.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_twitch_device_flow_uses_own_public_client_minimal_scope_and_validates_account(self):
        transport = FakeTransport("twitch")
        original = transport.request
        def request(method, url, **kwargs):
            if url.endswith("/oauth2/device"):
                transport.calls.append((method, url, copy.deepcopy(kwargs)))
                return {"verification_uri": "https://www.twitch.tv/activate?public=true&device-code=FIXTURE", "user_code": "FIXTURE", "device_code": "fixture-device-code", "interval": 5, "expires_in": 1800}
            return original(method, url, **kwargs)
        transport.request = request
        now = [0]
        def sleep(seconds):
            now[0] += seconds
        opener = Mock(return_value=True)
        on_prompt = Mock()
        result = subject.authorize_twitch(client("twitch"), subject.AtomicTokenStore(self.path), "123", explicit=True, transport=transport, opener=opener, on_prompt=on_prompt, clock=lambda: 1000, monotonic=lambda: now[0], sleep=sleep)
        self.assertTrue(result["connected"])
        self.assertEqual(transport.calls[0][2]["form"], {"client_id": "fixture-own-twitch", "scopes": "channel:manage:broadcast"})
        self.assertEqual(transport.calls[-1][1], "https://id.twitch.tv/oauth2/validate")
        self.assertEqual(subject.secret_store.read_json(self.path)["own_client_id"], "fixture-own-twitch")
        self.assertNotIn("fixture-access", json.dumps(result))
        opener.assert_called_once()
        prompt = on_prompt.call_args.args[0]
        self.assertEqual(set(prompt), {"platform", "user_code", "verification_uri"})
        self.assertEqual(prompt["user_code"], "FIXTURE")
        self.assertNotIn("fixture-device-code", json.dumps(prompt))
        self.assertNotIn("fixture-new-access", json.dumps(prompt))

    def test_twitch_bare_verification_uri_exposes_human_code_and_handles_pending(self):
        transport = FakeTransport("twitch")
        original = transport.request
        pending = [True]
        def request(method, url, **kwargs):
            if url.endswith("/oauth2/device"):
                return {"verification_uri": "https://www.twitch.tv/activate", "user_code": "ABCD-1234", "device_code": "fixture-private-device-code", "interval": 5, "expires_in": 1800}
            if url.endswith("/oauth2/token") and pending and pending.pop():
                raise subject._HTTPFailure(400, "authorization_pending")
            return original(method, url, **kwargs)
        transport.request = request
        now = [0]
        def sleep(seconds):
            now[0] += seconds
        prompt, opener = Mock(), Mock(return_value=True)
        subject.authorize_twitch(client("twitch"), subject.AtomicTokenStore(self.path), "123", explicit=True,
                                 transport=transport, opener=opener, on_prompt=prompt,
                                 clock=lambda: 1000, monotonic=lambda: now[0], sleep=sleep)
        self.assertEqual(prompt.call_args.args[0], {"platform": "twitch", "user_code": "ABCD-1234", "verification_uri": "https://www.twitch.tv/activate"})
        opener.assert_called_once_with("https://www.twitch.tv/activate", new=1)
        self.assertEqual(now[0], 10)

    def test_twitch_device_flow_rejects_foreign_browser_destination(self):
        transport = Mock()
        transport.request.return_value = {"verification_uri": "https://evil.invalid/activate?token=fixture-secret", "user_code": "FIXTURE", "device_code": "fixture-device-code", "interval": 5, "expires_in": 1800}
        opener = Mock()
        with self.assertRaises(subject.TitleAdapterError):
            subject.authorize_twitch(client("twitch"), subject.AtomicTokenStore(self.path), "123", explicit=True, transport=transport, opener=opener)
        opener.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_kick_pkce_state_and_own_client_identity_before_persist(self):
        transport = FakeTransport("kick")
        captured = {}
        def receiver(redirect, state, url, opener, timeout):
            query = parse_qs(urlsplit(url).query)
            captured.update(query=query, state=state)
            self.assertEqual(redirect, client("kick")["redirect_uri"])
            self.assertEqual(query["state"], [state])
            self.assertGreaterEqual(len(state), 32)
            self.assertEqual(query["code_challenge_method"], ["S256"])
            self.assertEqual(set(query["scope"][0].split()), {"channel:read", "channel:write"})
            self.assertEqual(timeout, 180)
            return "fixture-callback-code"
        result = subject.authorize_kick(client("kick"), subject.AtomicTokenStore(self.path), "123", explicit=True, transport=transport, opener=Mock(), callback_receiver=receiver, clock=lambda: 1000)
        form = transport.calls[0][2]["form"]
        challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(captured["query"]["code_challenge"], [challenge])
        self.assertEqual(form["client_secret"], "fixture-kick-secret")
        self.assertEqual(form["code"], "fixture-callback-code")
        self.assertEqual([urlsplit(call[1]).path for call in transport.calls], ["/oauth/token", "/oauth/token/introspect", "/public/v1/channels"])
        self.assertTrue(result["connected"])
        self.assertEqual(subject.secret_store.read_json(self.path)["expected_user_id"], "123")

    def test_kick_bad_account_or_app_token_is_never_saved(self):
        for case in ("foreign-account", "app-token", "inactive"):
            transport = FakeTransport("kick")
            if case == "foreign-account":
                transport.user_id = "999"
            elif case == "app-token":
                transport.token_type = "app"
            else:
                transport.active = False
            with self.assertRaises(subject.TitleAdapterError):
                subject.authorize_kick(client("kick"), subject.AtomicTokenStore(self.path), "123", explicit=True, transport=transport, opener=Mock(), callback_receiver=lambda *args: "fixture-code")
            self.assertFalse(self.path.exists())

    def test_callback_rejects_wrong_host_state_path_and_duplicate_codes(self):
        redirect = client("kick")["redirect_uri"]
        valid = "/oauth/kickcallback?state=fixture-state&code=fixture-code"
        self.assertEqual(subject._kick_callback_code(valid, "localhost:18766", redirect, "fixture-state"), "fixture-code")
        for path, host in ((valid, "evil.invalid"), (valid.replace("fixture-state", "wrong-state"), "localhost:18766"),
                           (valid.replace("kickcallback", "other"), "localhost:18766"), (valid + "&code=duplicate", "localhost:18766"),
                           (valid + "&state=duplicate", "localhost:18766"), ("http://evil.invalid" + valid, "localhost:18766")):
            self.assertNotEqual(subject._kick_callback_code(path, host, redirect, "fixture-state"), "fixture-code")
        self.assertIs(subject._kick_callback_code("/oauth/kickcallback?state=fixture-state&error=access_denied", "localhost:18766", redirect, "fixture-state"), False)

    def test_own_app_and_localhost_registration_are_required(self):
        for change in ({"ownership": "obs-app"}, {"redirect_uri": "http://127.0.0.1:18766/oauth/kickcallback"},
                       {"redirect_uri": "https://localhost:18766/oauth/kickcallback"}, {"redirect_uri": "http://localhost/oauth/kickcallback"},
                       {"redirect_uri": "http://localhost:18766/oauth/kickcallback?code=private"}, {"client_secret": ""}):
            changed = {**client("kick"), **change}
            transport = Mock()
            with self.assertRaises(subject.TitleAdapterError):
                subject.authorize_kick(changed, subject.AtomicTokenStore(self.path), "123", explicit=True, transport=transport)
            transport.request.assert_not_called()


class AppPersistenceTests(NetworkFreeTest):
    def test_restart_reload_uses_only_dpapi_own_app_record_and_no_startup_network(self):
        directory = Path(self.directory.name)
        transport = FakeTransport("kick")
        config_path, token_path = subject._paths("kick", directory)
        subject.secret_store.write_json(config_path, {"client": client("kick"), "expected_user_id": "123", "expected_login": "fixture_account"})
        subject.secret_store.write_json(token_path, record("kick"))
        adapter = subject.load_adapter("kick", directory, transport=transport)
        self.assertIsInstance(adapter, subject.KickTitleAdapter)
        self.assertIsNotNone(adapter.credentials)
        self.assertEqual(adapter.credentials.expected_user_id, "123")
        self.assertEqual(transport.calls, [])
        self.assertTrue(config_path.read_bytes().startswith(b"SC2TOOLS-DPAPI-1\n"))
        self.assertTrue(token_path.read_bytes().startswith(b"SC2TOOLS-DPAPI-1\n"))
        with self.assertRaises(subject.TitleAdapterError):
            adapter.update_title("New title")
        self.assertEqual(transport.calls, [])

    def test_missing_plaintext_and_foreign_connections_are_disconnected(self):
        directory = Path(self.directory.name)
        transport = FakeTransport("twitch")
        config_path, token_path = subject._paths("twitch", directory)
        self.assertIsNone(subject.load_adapter("twitch", directory, transport=transport).credentials)
        config_path.write_text(json.dumps({"client": client("twitch"), "expected_user_id": "123"}))
        token_path.write_text(json.dumps(record("twitch")))
        self.assertIsNone(subject.load_adapter("twitch", directory, transport=transport).credentials)
        subject.secret_store.write_json(config_path, {"client": client("twitch"), "expected_user_id": "123"})
        wrong = {**record("twitch"), "own_client_id": "fixture-borrowed-app"}
        subject.secret_store.write_json(token_path, wrong)
        self.assertIsNone(subject.load_adapter("twitch", directory, transport=transport).credentials)
        self.assertEqual(transport.calls, [])

    def test_automatic_connection_reload_does_not_bypass_write_gate(self):
        directory = Path(self.directory.name)
        transport = FakeTransport("twitch")
        config_path, token_path = subject._paths("twitch", directory)
        subject.secret_store.write_json(config_path, {"client": client("twitch"), "expected_user_id": "123"})
        subject.secret_store.write_json(token_path, record("twitch"))
        adapter = subject.load_adapter("twitch", directory, write_enabled=True, transport=transport)
        self.assertEqual(adapter.update_title("New title")["title"], "New title")
        self.assertEqual(sum(method == "PATCH" for method, _, _ in transport.calls), 1)

    def test_connect_pins_oauth_subject_and_privately_saves_own_client_for_restart(self):
        directory = Path(self.directory.name)
        transport = FakeTransport("kick")
        result = subject.connect_kick(client("kick"), directory, explicit=True, expected_login="@FIXTURE_ACCOUNT", transport=transport,
                                      callback_receiver=lambda *args: "fixture-code", opener=Mock(), clock=lambda: 1000)
        self.assertEqual(result["user_id"], "123")
        self.assertEqual(result["account"], "fixture_account")
        self.assertNotIn("fixture-kick-secret", json.dumps(result))
        config_path, _ = subject._paths("kick", directory)
        config = subject.secret_store.read_json(config_path)
        self.assertEqual(config["client"], client("kick"))
        self.assertEqual(config["expected_user_id"], "123")
        calls_before = len(transport.calls)
        adapter = subject.load_adapter("kick", directory, transport=transport)
        self.assertIsNotNone(adapter.credentials)
        self.assertEqual(len(transport.calls), calls_before)

    def test_expected_account_mismatch_saves_no_token_or_client(self):
        directory = Path(self.directory.name)
        transport = FakeTransport("kick")
        with self.assertRaises(subject.TitleAdapterError):
            subject.connect_kick(client("kick"), directory, explicit=True, expected_login="wrong_account", transport=transport,
                                 callback_receiver=lambda *args: "fixture-code", opener=Mock())
        config_path, token_path = subject._paths("kick", directory)
        self.assertFalse(config_path.exists())
        self.assertFalse(token_path.exists())

    def test_connect_without_explicit_flag_creates_no_directory_or_credentials(self):
        directory = Path(self.directory.name) / "not-created"
        with self.assertRaises(subject.TitleAdapterError):
            subject.connect_twitch(client("twitch"), directory)
        self.assertFalse(directory.exists())


class TransportTests(NetworkFreeTest):
    def test_official_host_allowlist_and_read_write_boundaries(self):
        transport = subject.OfficialHTTP()
        transport._opener = Mock()
        for method, url, kwargs in (("POST", "http://id.kick.com/oauth/token", {}),
                                    ("GET", "https://api.twitch.tv.evil.invalid/helix/channels", {}),
                                    ("GET", "https://api.twitch.tv/helix/streams", {}),
                                    ("GET", "https://api.twitch.tv/helix/channels", {"body": {"title": "x"}}),
                                    ("DELETE", "https://api.twitch.tv/helix/channels", {}),
                                    ("GET", "https://fixture-secret@api.twitch.tv/helix/channels", {})):
            with self.assertRaises(subject.TitleAdapterError):
                transport.request(method, url, **kwargs)
        transport._opener.open.assert_not_called()

    def test_http_error_suppresses_url_private_body_and_transport_message(self):
        transport = subject.OfficialHTTP()
        transport._opener = Mock()
        transport._opener.open.side_effect = HTTPError("https://private.invalid?token=fixture-secret", 403, "fixture-private-message", {}, io.BytesIO(b'{"error":"fixture-private-body"}'))
        with self.assertRaises(subject.TitleAdapterError) as caught:
            transport.request("GET", "https://api.twitch.tv/helix/channels")
        self.assertEqual(str(caught.exception), "Official platform operation failed with HTTP 403; private response withheld.")

    def test_redirects_never_forward_authorization(self):
        redirect = subject._NoRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, None, None, None, "https://evil.invalid/"))


if __name__ == "__main__":
    unittest.main()
