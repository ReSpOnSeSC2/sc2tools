"""Network-free paired backend tests. All IDs, credentials and API rows are fake."""

import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from sc2tools_agent.streaming.youtube_pair_backend import PairBackend, PairObserver, BackendError, SCOPES, STATE_NAME, TEMPLATE_NAME, DESCRIPTION_LIMIT_BYTES, PARTNER_LINK_RESERVED_BYTES, OPERATION_MARKER_RESERVED_BYTES, IDLE_POLL_SECONDS

STOPPED = {"horizontal": False, "portrait": False}
RUNNING = {"horizontal": True, "portrait": True}


def configuration():
    return {
        "mode": "separate-events", "user_approved_separate_events": True,
        "existing_reusable_keys_confirmed": True, "expected_channel_id": "mock-channel",
        "runtime_enabled": True, "auto_rearm": True,
        "metadata": {"title": "SC2 Live", "description": "Mock description", "vertical_suffix": " | Vertical"},
        "streams": {scope: {"reusable_stream_id": "mock-stream-" + scope, "privacy": "unlisted", "made_for_kids": False} for scope in SCOPES},
    }


class Clock:
    def __init__(self):
        self.now = 1800000000.0

    def __call__(self):
        return self.now


class FakeGoogle:
    write_enabled = True

    def __init__(self):
        self.rows = {}
        self.calls = []
        self.ingest = "inactive"
        self.fail_create = False
        self.fail_bind = False
        self.fail_metadata = False
        self.fail_read = False
        self.read_http_status = None

    def streams_by_ids(self, ids):
        self.calls.append("streams")
        return [{"id": value, "snippet": {"channelId": "mock-channel"}, "status": {"streamStatus": self.ingest}} for value in ids]

    def all_owned_broadcasts(self):
        self.calls.append("all")
        return copy.deepcopy(list(self.rows.values()))

    def occupied_broadcasts(self):
        return [row for row in self.all_owned_broadcasts() if row["status"]["lifeCycleStatus"] not in {"complete", "revoked"}]

    def broadcasts_by_ids(self, ids):
        self.calls.append("get-pair")
        if self.fail_read:
            error = TimeoutError("Mock GET failed.")
            error.http_status = self.read_http_status
            raise error
        return [copy.deepcopy(self.rows[value]) for value in ids]

    def broadcast_by_id(self, value):
        return self.broadcasts_by_ids([value])[0]

    def create_broadcast(self, body):
        self.calls.append("create")
        value = "mock-event-" + str(len(self.rows) + 1)
        row = {"id": value, "snippet": {**copy.deepcopy(body["snippet"]), "channelId": "mock-channel"}, "status": {**body["status"], "lifeCycleStatus": "created"}, "contentDetails": copy.deepcopy(body["contentDetails"])}
        self.rows[value] = row
        if self.fail_create:
            raise TimeoutError("Mock lost create response.")
        return copy.deepcopy(row)

    def bind_broadcast(self, event, stream):
        self.calls.append("bind")
        self.rows[event]["contentDetails"]["boundStreamId"] = stream
        self.rows[event]["status"]["lifeCycleStatus"] = "ready"
        if self.fail_bind:
            raise TimeoutError("Mock lost bind response.")
        return copy.deepcopy(self.rows[event])

    def update_video_metadata(self, event, title, description, channel):
        self.calls.append("metadata")
        if self.fail_metadata:
            raise TimeoutError("Mock PUT response lost.")
        if channel != self.rows[event]["snippet"]["channelId"]:
            raise AssertionError("Wrong channel.")
        self.rows[event]["snippet"].update(title=title, description=description)
        self.rows[event].pop("metadataPending", None)
        return copy.deepcopy(self.rows[event])

    def foreign(self):
        self.rows["mock-foreign"] = {"id": "mock-foreign", "snippet": {"channelId": "mock-channel"}, "status": {"lifeCycleStatus": "ready"}, "contentDetails": {"boundStreamId": "mock-stream-horizontal"}}

    def lifecycle(self, status):
        for row in self.rows.values():
            row["status"]["lifeCycleStatus"] = status


class PairTests(unittest.TestCase):
    def setUp(self):
        self.api, self.clock = FakeGoogle(), Clock()
        self.backend = PairBackend(Path("."), api=self.api, config=configuration(), writes_enabled=True, memory=True, clock=self.clock)

    def prepare(self):
        return self.backend.dispatch({"action": "prepare"}, STOPPED)

    def test_prepare_binds_both_before_any_observation_of_active_ingest(self):
        result = self.prepare()
        self.assertTrue(result["pair_ready"])
        self.assertEqual(self.api.calls.count("create"), 2)
        self.assertEqual(self.api.calls.count("bind"), 2)
        self.assertEqual({row["contentDetails"]["boundStreamId"] for row in self.api.rows.values()}, {"mock-stream-horizontal", "mock-stream-portrait"})
        self.assertTrue(all(row["contentDetails"]["enableAutoStart"] for row in self.api.rows.values()))
        self.assertTrue(all(row["snippet"]["categoryId"] == "20" for row in self.api.rows.values()))

    def test_repeated_prepare_is_idempotent(self):
        self.prepare()
        self.prepare()
        self.assertEqual(self.api.calls.count("create"), 2)
        self.assertEqual(self.api.calls.count("bind"), 2)

    def test_active_ingest_edge_never_creates_events(self):
        result = self.backend.runtime_tick(RUNNING)
        self.assertEqual(result["code"], "outputs_without_pair")
        self.assertNotIn("create", self.api.calls)

    def test_prepare_blocks_local_active_unknown_and_cloud_active(self):
        self.assertEqual(self.backend.prepare_pair(RUNNING)["code"], "outputs_active")
        self.assertEqual(self.backend.prepare_pair({"horizontal": None, "portrait": False})["code"], "outputs_unknown")
        self.api.ingest = "active"
        self.assertEqual(self.prepare()["code"], "cloud_ingest_active")
        self.assertNotIn("create", self.api.calls)

    def test_fresh_local_state_blocks_at_every_create_and_bind_boundary(self):
        for boundary, creates, binds in ((1, 0, 0), (2, 1, 0), (3, 1, 1), (4, 2, 1)):
            with self.subTest(boundary=boundary):
                api = FakeGoogle()
                reads = []
                def outputs():
                    reads.append(True)
                    return RUNNING if len(reads) == boundary else STOPPED
                backend = PairBackend(Path("."), api=api, config=configuration(), writes_enabled=True, memory=True, output_reader=outputs)
                self.assertEqual(backend.prepare_pair(STOPPED)["code"], "outputs_active")
                self.assertEqual(api.calls.count("create"), creates)
                self.assertEqual(api.calls.count("bind"), binds)
                self.assertFalse(any(entry["phase"] in {"creating", "creation_uncertain", "binding_uncertain"} for entry in backend._entries().values()))
                backend.output_reader = lambda: STOPPED
                self.assertTrue(backend.recover_pair(STOPPED)["pair_ready"])
                self.assertEqual(api.calls.count("create"), 2)

    def test_cloud_ingest_rechecked_at_every_create_and_bind_boundary(self):
        for query, creates, binds in ((2, 0, 0), (3, 1, 0), (4, 1, 1), (5, 2, 1)):
            with self.subTest(query=query):
                api, calls = FakeGoogle(), []
                original = api.streams_by_ids
                def streams(ids):
                    calls.append(True)
                    api.ingest = "active" if len(calls) == query else "inactive"
                    return original(ids)
                api.streams_by_ids = streams
                backend = PairBackend(Path("."), api=api, config=configuration(), writes_enabled=True, memory=True, output_reader=lambda: STOPPED)
                self.assertEqual(backend.prepare_pair(STOPPED)["code"], "cloud_ingest_active")
                self.assertEqual(api.calls.count("create"), creates)
                self.assertEqual(api.calls.count("bind"), binds)

    def test_recovery_bind_also_requires_a_fresh_local_stopped_read(self):
        reads = []
        def outputs():
            reads.append(True)
            return STOPPED if len(reads) == 1 else RUNNING
        self.backend.output_reader = outputs
        self.assertEqual(self.prepare()["code"], "outputs_active")
        owned_id = self.backend._entries()["horizontal"]["broadcast_id"]
        self.assertEqual(self.backend.recover_pair(STOPPED)["code"], "outputs_active")
        self.assertEqual(self.api.calls.count("create"), 1)
        self.assertNotIn("bind", self.api.calls)
        self.backend.output_reader = lambda: STOPPED
        self.assertTrue(self.backend.recover_pair(STOPPED)["pair_ready"])
        self.assertEqual(self.backend._entries()["horizontal"]["broadcast_id"], owned_id)
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_failed_fresh_output_read_fails_closed_before_creation(self):
        def outputs():
            raise OSError("Mock disconnected output reader.")
        self.backend.output_reader = outputs
        self.assertEqual(self.prepare()["code"], "outputs_unknown")
        self.assertNotIn("create", self.api.calls)

    def test_recovery_bind_rechecks_cloud_ingest_after_initial_snapshot(self):
        reads = []
        self.backend.output_reader = lambda: STOPPED if not reads else RUNNING
        original_create = self.api.create_broadcast
        def create(body):
            value = original_create(body)
            reads.append(True)
            return value
        self.api.create_broadcast = create
        self.assertEqual(self.prepare()["code"], "outputs_active")
        self.backend.output_reader = lambda: STOPPED
        original_streams = self.api.streams_by_ids
        queries = []
        def streams(ids):
            queries.append(True)
            self.api.ingest = "active" if len(queries) == 2 else "inactive"
            return original_streams(ids)
        self.api.streams_by_ids = streams
        self.assertEqual(self.backend.recover_pair(STOPPED)["code"], "cloud_ingest_active")
        self.assertEqual(self.api.calls.count("create"), 1)
        self.assertNotIn("bind", self.api.calls)

    def test_foreign_pending_appearing_during_creation_blocks_binding(self):
        original = self.api.create_broadcast
        def create(body):
            own = original(body)
            self.api.foreign()
            return own
        self.api.create_broadcast = create
        self.assertEqual(self.prepare()["code"], "foreign_event_conflict")
        self.assertEqual(self.api.calls.count("create"), 1)
        self.assertNotIn("bind", self.api.calls)
        self.assertEqual(self.backend._entries()["horizontal"]["phase"], "created")
        self.assertEqual(self.api.rows["mock-foreign"]["status"]["lifeCycleStatus"], "ready")

    def test_foreign_pending_preserved_and_blocks_pair(self):
        self.api.foreign()
        self.assertEqual(self.prepare()["code"], "foreign_event_conflict")
        self.assertEqual(len(self.api.rows), 1)
        self.assertNotIn("create", self.api.calls)

    def test_uncertain_create_never_retries(self):
        self.api.fail_create = True
        self.assertEqual(self.prepare()["code"], "creation_uncertain")
        self.api.fail_create = False
        self.assertEqual(self.prepare()["code"], "creation_uncertain")
        self.assertEqual(self.api.calls.count("create"), 1)
        self.assertEqual(self.backend.public_status()["channels"]["horizontal"]["recovery_candidate_count"], 1)

    def test_uncertain_bind_recovers_same_owned_event_then_finishes_pair(self):
        self.api.fail_bind = True
        self.assertEqual(self.prepare()["code"], "binding_uncertain")
        self.api.fail_bind = False
        result = self.backend.recover_pair(STOPPED)
        self.assertTrue(result["pair_ready"])
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_auto_rearm_requires_both_terminal_and_outputs_stopped(self):
        self.prepare()
        self.api.lifecycle("live")
        self.backend.runtime_tick(RUNNING)
        first = next(iter(self.api.rows.values()))
        first["status"]["lifeCycleStatus"] = "complete"
        self.clock.now += 70
        self.backend.runtime_tick(STOPPED)
        self.assertEqual(self.api.calls.count("create"), 2)
        self.api.lifecycle("complete")
        self.clock.now += 70
        self.backend.runtime_tick(RUNNING)
        self.assertEqual(self.api.calls.count("create"), 2)
        self.clock.now += 70
        result = self.backend.runtime_tick(STOPPED)
        self.assertTrue(result["pair_ready"])
        self.assertEqual(self.api.calls.count("create"), 4)

    def test_auto_rearm_disabled_until_initial_explicit_prepare_and_config(self):
        for _ in range(3):
            self.clock.now += 100000
            self.backend.runtime_tick(STOPPED)
        self.assertNotIn("create", self.api.calls)
        self.prepare()
        self.backend.config["auto_rearm"] = False
        self.api.lifecycle("complete")
        self.clock.now += 50
        self.backend.runtime_tick(STOPPED)
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_long_session_has_no_one_hour_cap(self):
        self.prepare()
        self.api.lifecycle("live")
        self.backend.runtime_tick(RUNNING)
        self.clock.now += 13 * 3600
        result = self.backend.runtime_tick(RUNNING)
        self.assertEqual(result["phase"], "live")
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_idle_prepared_pair_polls_only_every_fifteen_minutes_and_start_is_immediate(self):
        self.prepare()
        before = self.api.calls.count("get-pair")
        for _ in range(2 * 3600 // 2):
            self.clock.now += 2
            self.backend.runtime_tick(STOPPED)
        self.assertEqual(self.api.calls.count("get-pair") - before, 2 * 3600 // IDLE_POLL_SECONDS)
        before = self.api.calls.count("get-pair")
        self.clock.now += 2
        self.backend.runtime_tick(RUNNING)
        self.assertEqual(self.api.calls.count("get-pair"), before + 1)
        self.assertEqual(self.backend.state["next_poll"], self.clock.now + 10)

    def test_transient_poll_backoff_grows_and_success_resets_it(self):
        self.prepare()
        self.api.fail_read = True
        self.clock.now += IDLE_POLL_SECONDS
        self.backend.runtime_tick(STOPPED)
        self.assertEqual(self.backend.state["poll_not_before"], self.clock.now + 30)
        self.clock.now += 30
        self.backend.runtime_tick(STOPPED)
        self.assertEqual(self.backend.state["poll_not_before"], self.clock.now + 60)
        self.api.fail_read = False
        self.clock.now += 60
        self.assertTrue(self.backend.runtime_tick(STOPPED)["pair_ready"])
        self.assertEqual(self.backend.state["poll_failures"], 0)
        self.assertEqual(self.backend.state["poll_not_before"], 0)

    def test_auth_and_quota_pauses_cannot_be_bypassed_by_output_toggles(self):
        for http_status, pause in ((401, 900), (403, 900), (429, 1800)):
            with self.subTest(status=http_status):
                api, clock = FakeGoogle(), Clock()
                backend = PairBackend(Path("."), api=api, config=configuration(), writes_enabled=True, memory=True, clock=clock)
                backend.prepare_pair(STOPPED)
                api.fail_read, api.read_http_status = True, http_status
                clock.now += IDLE_POLL_SECONDS
                backend.runtime_tick(STOPPED)
                self.assertEqual(backend.state["poll_not_before"], clock.now + pause)
                reads = api.calls.count("get-pair")
                for states in (RUNNING, STOPPED, RUNNING, STOPPED):
                    clock.now += 10
                    backend.runtime_tick(states)
                self.assertEqual(api.calls.count("get-pair"), reads)
                api.fail_read = False
                self.assertTrue(backend.prepare_pair(STOPPED)["pair_ready"])
                self.assertEqual(backend.state["poll_not_before"], 0)

    def test_remote_create_uuid_is_durable_before_post_and_explicit_recovery_reuses_id(self):
        backend = self.backend
        class Remote(FakeGoogle):
            requires_operation_id = True
            def __init__(self):
                super().__init__()
                self.operations = {}
            def create_broadcast(self, body, *, operation_id):
                self.assert_intent(operation_id)
                row = super().create_broadcast(body)
                self.operations[operation_id] = row["id"]
                if len(self.operations) == 1:
                    raise TimeoutError("Mock facade response lost.")
                return row
            def assert_intent(self, operation_id):
                uuid.UUID(operation_id)
                assert any(entry.get("operation_id") == operation_id and entry["phase"] == "creating" for entry in backend._entries().values())
            def recover_create(self, operation_id):
                self.calls.append("recover-create")
                return copy.deepcopy(self.rows[self.operations[operation_id]])
        api = Remote()
        self.backend.api = api
        self.assertEqual(self.prepare()["code"], "creation_uncertain")
        operation_id = self.backend._entries()["horizontal"]["operation_id"]
        own_id = api.operations[operation_id]
        self.assertEqual(self.prepare()["code"], "creation_uncertain")
        self.assertEqual(api.calls.count("create"), 1)
        self.assertTrue(self.backend.recover_pair(STOPPED)["pair_ready"])
        self.assertEqual(self.backend._entries()["horizontal"]["broadcast_id"], own_id)
        self.assertEqual(api.calls.count("create"), 2)
        self.assertEqual(api.calls.count("recover-create"), 1)

    def test_remote_recovery_rejects_unproved_metadata_and_missing_old_operation_id(self):
        self.api.fail_create = True
        self.assertEqual(self.prepare()["code"], "creation_uncertain")
        self.api.requires_operation_id = True
        row = copy.deepcopy(next(iter(self.api.rows.values())))
        row["snippet"]["description"] = "Foreign description with similar title"
        self.api.recover_create = lambda operation_id: row
        self.assertEqual(self.backend.recover_pair(STOPPED)["code"], "ownership_changed")
        self.assertNotIn("broadcast_id", self.backend._entries()["horizontal"])
        self.backend._entries()["horizontal"].pop("operation_id")
        self.api.recover_create = lambda operation_id: self.fail("An old unsafe intent must not invoke remote recovery.")
        self.assertEqual(self.backend.recover_pair(STOPPED)["code"], "creation_uncertain")
        self.assertEqual(self.api.calls.count("create"), 1)

    def test_new_creation_schedule_uses_utc_whole_seconds(self):
        self.clock.now += 0.961381
        scheduled = self.backend._body("horizontal")["snippet"]["scheduledStartTime"]
        expected = (datetime.fromtimestamp(self.clock.now, timezone.utc) + timedelta(seconds=60)).replace(microsecond=0)
        self.assertEqual(scheduled, expected.isoformat(timespec="seconds").replace("+00:00", "Z"))
        self.assertNotIn(".", scheduled)
        self.assertEqual(self.api.calls, [])

    def test_persisted_fractional_intent_recovers_same_remote_id_without_reinsert(self):
        class Remote(FakeGoogle):
            requires_operation_id = True

            def __init__(self):
                super().__init__()
                self.operations = {}

            def create_broadcast(self, body, *, operation_id):
                row = super().create_broadcast(body)
                self.operations[operation_id] = row["id"]
                start = datetime.fromisoformat(row["snippet"]["scheduledStartTime"].replace("Z", "+00:00"))
                self.rows[row["id"]]["snippet"]["scheduledStartTime"] = start.isoformat(timespec="seconds").replace("+00:00", "Z")
                if len(self.operations) == 1:
                    raise TimeoutError("Mock facade response lost after insertion.")
                return copy.deepcopy(self.rows[row["id"]])

            def recover_create(self, operation_id):
                self.calls.append("recover-create")
                return copy.deepcopy(self.rows[self.operations[operation_id]])

        with tempfile.TemporaryDirectory(prefix="pair-second-recovery-", dir=Path(__file__).resolve().parent) as directory:
            api, clock = Remote(), Clock()
            clock.now += 0.961381
            backend = PairBackend(Path(directory), api=api, config=configuration(), writes_enabled=True, clock=clock)
            current_body = backend._body

            def old_fractional_body(scope):
                body = current_body(scope)
                body["snippet"]["scheduledStartTime"] = (datetime.fromtimestamp(clock.now, timezone.utc) + timedelta(seconds=60)).isoformat().replace("+00:00", "Z")
                return body

            backend._body = old_fractional_body
            try:
                self.assertEqual(backend.prepare_pair(STOPPED)["code"], "creation_uncertain")
                entry = copy.deepcopy(backend._entries()["horizontal"])
                operation_id = entry["operation_id"]
                own_id = api.operations[operation_id]
                self.assertIn(".961381", entry["create_body"]["snippet"]["scheduledStartTime"])
            finally:
                backend.close()
            resumed = PairBackend(Path(directory), api=api, config=configuration(), writes_enabled=True, clock=clock)
            try:
                self.assertTrue(resumed.recover_pair(STOPPED)["pair_ready"])
                recovered = resumed._entries()["horizontal"]
                self.assertEqual(recovered["broadcast_id"], own_id)
                self.assertEqual(recovered["operation_id"], operation_id)
                self.assertEqual(recovered["create_body"]["snippet"]["scheduledStartTime"], entry["create_body"]["snippet"]["scheduledStartTime"])
                self.assertEqual(api.calls.count("recover-create"), 1)
                self.assertEqual(api.calls.count("create"), 2)  # Original H, then first V.
            finally:
                resumed.close()

    def test_remote_recovery_rejects_different_second_and_changed_metadata(self):
        for change in ("different-second", "description"):
            with self.subTest(change=change):
                api = FakeGoogle()
                api.fail_create = True
                backend = PairBackend(Path("."), api=api, config=configuration(), writes_enabled=True, memory=True, clock=self.clock)
                self.assertEqual(backend.prepare_pair(STOPPED)["code"], "creation_uncertain")
                row = copy.deepcopy(next(iter(api.rows.values())))
                if change == "different-second":
                    start = datetime.fromisoformat(row["snippet"]["scheduledStartTime"].replace("Z", "+00:00"))
                    row["snippet"]["scheduledStartTime"] = (start + timedelta(seconds=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
                else:
                    row["snippet"]["description"] += " changed"
                api.requires_operation_id = True
                api.recover_create = lambda operation_id: copy.deepcopy(row)
                self.assertEqual(backend.recover_pair(STOPPED)["code"], "ownership_changed")
                self.assertNotIn("broadcast_id", backend._entries()["horizontal"])
                self.assertEqual(api.calls.count("create"), 1)

    def test_starting_and_stopping_are_not_advertised_as_ready(self):
        self.assertTrue(self.prepare()["pair_ready"])
        result = self.backend.runtime_tick(RUNNING)
        self.assertEqual(result["phase"], "starting")
        self.assertFalse(result["pair_ready"])
        self.assertTrue(all(row["display_phase"] == "starting" for row in result["channels"].values()))
        self.api.lifecycle("live")
        self.clock.now += 15
        result = self.backend.runtime_tick(RUNNING)
        self.assertTrue(all(row["display_phase"] == "live" for row in result["channels"].values()))
        result = self.backend.runtime_tick(STOPPED)
        self.assertFalse(result["pair_ready"])
        self.assertTrue(all(row["display_phase"] == "stopping" for row in result["channels"].values()))

    def test_future_privacy_gate_requires_fresh_terminal_pair_and_keeps_state(self):
        self.prepare()
        candidate = copy.deepcopy(self.backend.config)
        for setting in candidate["streams"].values():
            setting["privacy"] = "public"
        self.api.lifecycle("complete")
        before = copy.deepcopy(self.backend.state)
        writes = [call for call in self.api.calls if call in {"create", "bind", "metadata"}]
        self.assertTrue(self.backend.verify_future_configuration(candidate, STOPPED))
        self.assertEqual(self.backend.state, before)
        self.assertEqual([call for call in self.api.calls if call in {"create", "bind", "metadata"}], writes)
        self.backend.config = candidate
        result = self.prepare()
        self.assertTrue(result["pair_ready"])
        self.assertEqual([row["status"]["privacyStatus"] for row in list(self.api.rows.values())[:2]], ["unlisted", "unlisted"])
        self.assertEqual([row["status"]["privacyStatus"] for row in list(self.api.rows.values())[2:]], ["public", "public"])

    def test_future_settings_gate_blocks_nonterminal_changed_keys_and_active_outputs(self):
        self.prepare()
        candidate = copy.deepcopy(self.backend.config)
        for lifecycle in ("ready", "live", "testing"):
            self.api.lifecycle(lifecycle)
            with self.subTest(lifecycle=lifecycle), self.assertRaises(BackendError) as error:
                self.backend.verify_future_configuration(candidate, STOPPED)
            self.assertEqual(error.exception.code, "pair_not_complete")
        self.api.lifecycle("complete")
        for scope in ("horizontal", "portrait", "channel"):
            changed = copy.deepcopy(candidate)
            if scope == "channel":
                changed["expected_channel_id"] = "different-channel"
            else:
                changed["streams"][scope]["reusable_stream_id"] = "different-stream"
            with self.subTest(scope=scope), self.assertRaises(BackendError) as error:
                self.backend.verify_future_configuration(changed, STOPPED)
            self.assertEqual(error.exception.code, "configuration_required")
        with self.assertRaises(BackendError) as error:
            self.backend.verify_future_configuration(candidate, RUNNING)
        self.assertEqual(error.exception.code, "outputs_active")
        self.api.ingest = "active"
        with self.assertRaises(BackendError) as error:
            self.backend.verify_future_configuration(candidate, STOPPED)
        self.assertEqual(error.exception.code, "cloud_ingest_active")

    def test_future_settings_gate_blocks_partial_terminal_and_fresh_output_race(self):
        self.prepare()
        candidate = copy.deepcopy(self.backend.config)
        self.api.lifecycle("complete")
        self.api.rows[self.backend._entries()["portrait"]["broadcast_id"]]["status"]["lifeCycleStatus"] = "live"
        with self.assertRaises(BackendError) as error:
            self.backend.verify_future_configuration(candidate, STOPPED)
        self.assertEqual(error.exception.code, "pair_not_complete")
        self.api.lifecycle("complete")
        self.backend.output_reader = lambda: RUNNING
        with self.assertRaises(BackendError) as error:
            self.backend.verify_future_configuration(candidate, STOPPED)
        self.assertEqual(error.exception.code, "outputs_active")

    def test_quick_reconnect_preserves_pair_and_resets_stop_time(self):
        self.prepare()
        self.api.lifecycle("live")
        self.backend.runtime_tick(RUNNING)
        self.backend.runtime_tick(STOPPED)
        self.clock.now += 10
        self.backend.runtime_tick(RUNNING)
        self.clock.now += 200
        result = self.backend.runtime_tick(RUNNING)
        self.assertEqual(result["phase"], "live")
        self.assertNotIn("stopped_at", self.backend.state["pair"])
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_metadata_changes_only_owned_current_pair_and_future_template(self):
        self.prepare()
        self.api.lifecycle("live")
        self.api.foreign()
        foreign = copy.deepcopy(self.api.rows["mock-foreign"])
        result = self.backend.set_metadata("New title", "New description")
        self.assertEqual(result["metadata"]["title"], "New title")
        self.assertEqual(self.api.calls.count("metadata"), 2)
        self.assertEqual(self.api.rows["mock-foreign"], foreign)
        own = [row for key, row in self.api.rows.items() if key != "mock-foreign"]
        self.assertEqual({row["snippet"]["title"] for row in own}, {"New title", "New title | Vertical"})
        self.assertTrue(all(row["status"]["privacyStatus"] == "unlisted" for row in own))

    def test_portrait_description_link_survives_title_and_description_saves(self):
        self.prepare()
        entries = self.backend._entries()
        horizontal, portrait = (entries[scope]["broadcast_id"] for scope in SCOPES)
        prefix = "Watch the horizontal stream: https://www.youtube.com/watch?v=" + horizontal + "\n\n"
        self.assertEqual(self.api.rows[horizontal]["snippet"]["description"], "Mock description")
        self.assertEqual(self.api.rows[portrait]["snippet"]["description"], prefix + "Mock description")
        self.api.lifecycle("live")
        self.backend.set_metadata("Changed title", "Changed description")
        self.assertEqual(self.api.rows[horizontal]["snippet"]["description"], "Changed description")
        self.assertEqual(self.api.rows[portrait]["snippet"]["description"], prefix + "Changed description")
        self.backend.set_metadata("Title only", "Changed description")
        self.assertEqual(self.api.rows[portrait]["snippet"]["description"], prefix + "Changed description")
        self.assertEqual(self.backend._entries()["portrait"]["create_body"]["snippet"]["description"], prefix + "Changed description")

    def test_next_session_portrait_links_to_its_new_horizontal_partner(self):
        self.prepare()
        old_entries = copy.deepcopy(self.backend._entries())
        old_h, old_v = (old_entries[scope]["broadcast_id"] for scope in SCOPES)
        old_description = self.api.rows[old_v]["snippet"]["description"]
        self.api.lifecycle("complete")
        self.clock.now += IDLE_POLL_SECONDS + 1
        self.assertTrue(self.backend.runtime_tick(STOPPED)["pair_ready"])
        new_h, new_v = (self.backend._entries()[scope]["broadcast_id"] for scope in SCOPES)
        self.assertNotEqual(old_h, new_h)
        self.assertEqual(self.api.rows[new_v]["snippet"]["description"], "Watch the horizontal stream: https://www.youtube.com/watch?v=" + new_h + "\n\nMock description")
        self.assertNotIn(old_h, self.api.rows[new_v]["snippet"]["description"])
        self.assertEqual(self.api.rows[old_v]["snippet"]["description"], old_description)

    def test_description_reserves_utf8_space_for_generated_partner_link(self):
        limit = DESCRIPTION_LIMIT_BYTES - PARTNER_LINK_RESERVED_BYTES - OPERATION_MARKER_RESERVED_BYTES
        description = "\u754c" * (limit // 3)
        description += "x" * (limit - len(description.encode("utf-8")))
        self.assertTrue(self.backend.set_metadata("Okay", description)["future_template_saved"])
        self.assertTrue(self.prepare()["pair_ready"])
        for row in self.api.rows.values():
            self.assertLessEqual(len(row["snippet"]["description"].encode("utf-8")), DESCRIPTION_LIMIT_BYTES)
        before = self.api.calls.copy()
        self.assertEqual(self.backend.set_metadata("Okay", description + "x")["code"], "metadata_invalid")
        self.assertEqual(self.api.calls, before)

    def test_metadata_failure_stays_pending_then_idempotently_recovers(self):
        self.prepare()
        self.api.fail_metadata = True
        result = self.backend.set_metadata("New title", "New description")
        self.assertFalse(result["pair_ready"])
        self.assertTrue(result["channels"]["horizontal"]["metadata_pending"])
        self.api.fail_metadata = False
        self.clock.now += 40
        result = self.backend.runtime_tick(STOPPED)
        self.assertTrue(result["pair_ready"])
        self.assertEqual(result["phase"], "ready")
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_facade_cleanup_flag_blocks_ready_and_forces_owned_metadata_write(self):
        self.prepare()
        own_id = self.backend._entries()["horizontal"]["broadcast_id"]
        self.api.rows[own_id]["metadataPending"] = True
        self.api.fail_metadata = True
        self.clock.now += IDLE_POLL_SECONDS + 1
        result = self.backend.runtime_tick(STOPPED)
        self.assertFalse(result["pair_ready"])
        self.assertTrue(result["channels"]["horizontal"]["metadata_pending"])
        self.api.fail_metadata = False
        self.clock.now += 40
        result = self.backend.runtime_tick(STOPPED)
        self.assertTrue(result["pair_ready"])
        self.assertFalse(result["channels"]["horizontal"]["metadata_pending"])
        self.assertEqual(self.api.calls.count("create"), 2)

    def test_read_failure_cannot_restore_cached_ready_before_reverification(self):
        self.prepare()
        self.api.fail_read = True
        self.clock.now += IDLE_POLL_SECONDS + 1
        self.assertFalse(self.backend.runtime_tick(STOPPED)["pair_ready"])
        self.clock.now += 2
        self.assertFalse(self.backend.runtime_tick(STOPPED)["pair_ready"])
        self.api.fail_read = False
        self.clock.now += 40
        self.assertTrue(self.backend.runtime_tick(STOPPED)["pair_ready"])

    def test_automation_flags_changed_on_remote_event_block_ready(self):
        self.prepare()
        next(iter(self.api.rows.values()))["contentDetails"]["enableAutoStart"] = False
        self.assertFalse(self.prepare()["pair_ready"])

    def test_new_gaming_category_is_verified_before_ready(self):
        self.prepare()
        next(iter(self.api.rows.values()))["snippet"]["categoryId"] = "22"
        self.assertFalse(self.prepare()["pair_ready"])

    def test_public_status_never_contains_private_ids_or_keys(self):
        self.prepare()
        status = self.backend.public_status()
        self.assertEqual(set(status.pop("watch_urls")), set(SCOPES))
        encoded = json.dumps(status)
        for private_value in ("mock-channel", "mock-event-", "mock-stream-"):
            self.assertNotIn(private_value, encoded)

    def test_unknown_cloud_state_withholds_watch_urls(self):
        self.prepare()
        self.api.fail_read = True
        self.clock.now += IDLE_POLL_SECONDS + 1
        result = self.backend.runtime_tick(STOPPED)
        self.assertEqual(result["watch_urls"], {})

    def test_invalid_metadata_is_rejected_before_API(self):
        self.assertEqual(self.backend.set_metadata("<invalid>", "")["code"], "metadata_invalid")
        self.assertEqual(self.backend.set_metadata("x" * 100, "")["code"], "metadata_invalid")
        self.assertEqual(self.backend.set_metadata("Okay", "\u754c" * 2000)["code"], "metadata_invalid")
        self.assertEqual(self.api.calls, [])


class OfflineAndDurabilityTests(unittest.TestCase):
    def test_primary_disk_failure_preserves_previous_metadata_and_revision(self):
        with tempfile.TemporaryDirectory(prefix="sc2tools-youtube-test-", dir=Path(__file__).resolve().parent) as directory:
            backend = PairBackend(Path(directory), config=configuration())
            try:
                backend.set_metadata("Previous title", "Previous description")
                before = json.loads(backend.state_path.read_text(encoding="utf-8"))
                with patch("sc2tools_agent.streaming.youtube_pair_backend.atomic_json", side_effect=OSError("Mock disk full.")):
                    result = backend.set_metadata("Unsaved title", "Unsaved description")
                self.assertFalse(result["future_template_saved"])
                self.assertEqual(result["code"], "metadata_save_failed")
                self.assertEqual(result["metadata"]["title"], "Previous title")
                self.assertEqual(backend.state["metadata_revision"], before["metadata_revision"])
                self.assertEqual(json.loads(backend.state_path.read_text(encoding="utf-8")), before)
            finally:
                backend.close()

    def test_derived_template_failure_retains_durable_new_metadata(self):
        with tempfile.TemporaryDirectory(prefix="sc2tools-youtube-test-", dir=Path(__file__).resolve().parent) as directory:
            backend = PairBackend(Path(directory), config=configuration())
            try:
                backend.set_metadata("Previous title", "")
                from sc2tools_agent.streaming.youtube_pair_backend import atomic_json
                def writer(path, value):
                    if Path(path) == backend.template_path:
                        raise OSError("Mock derived template failure.")
                    return atomic_json(path, value)
                with patch("sc2tools_agent.streaming.youtube_pair_backend.atomic_json", side_effect=writer):
                    result = backend.set_metadata("Committed new title", "Committed description")
                self.assertTrue(result["future_template_saved"])
                self.assertEqual(result["metadata"]["title"], "Committed new title")
                stored = json.loads(backend.state_path.read_text(encoding="utf-8"))
                self.assertEqual(stored["metadata"]["title"], "Committed new title")
            finally:
                backend.close()

    def test_offline_title_save_and_observer_never_call_google(self):
        api = FakeGoogle()
        backend = PairBackend(Path("."), api=api, config=configuration(), writes_enabled=False, connected=False, memory=True)
        result = backend.set_metadata("Saved offline", "Future description")
        self.assertEqual(result["phase"], "authorization_required")
        self.assertEqual(result["metadata"]["title"], "Saved offline")
        backend.prepare_pair(STOPPED)
        backend.runtime_tick(STOPPED)
        self.assertEqual(api.calls, [])

    def test_each_execution_gate_blocks_before_API(self):
        for gate in ("runtime", "backend-write", "adapter-write", "approval"):
            with self.subTest(gate=gate):
                api, config = FakeGoogle(), configuration()
                writes = gate != "backend-write"
                if gate == "runtime":
                    config["runtime_enabled"] = False
                elif gate == "adapter-write":
                    api.write_enabled = False
                elif gate == "approval":
                    config["user_approved_separate_events"] = False
                backend = PairBackend(Path("."), api=api, config=config, writes_enabled=writes, memory=True)
                self.assertFalse(backend.prepare_pair(STOPPED)["ok"])
                self.assertEqual(api.calls, [])

    def test_new_metadata_and_revision_survive_stale_derived_template(self):
        with tempfile.TemporaryDirectory(prefix="sc2tools-youtube-test-", dir=Path(__file__).resolve().parent) as directory:
            work = Path(directory).resolve()
            self.assertTrue(work.is_relative_to(Path(__file__).resolve().parent))
            api, clock = FakeGoogle(), Clock()
            backend = PairBackend(work, api=api, config=configuration(), writes_enabled=True, clock=clock)
            backend.prepare_pair(STOPPED)
            api.fail_metadata = True
            backend.set_metadata("Durable new title", "Durable new description")
            backend.close()
            (work / TEMPLATE_NAME).write_text(json.dumps({"title": "Old template", "description": "", "vertical_suffix": " | Vertical"}))
            api.fail_metadata = False
            resumed = PairBackend(work, api=api, config=configuration(), writes_enabled=True, clock=clock)
            try:
                self.assertEqual(resumed.metadata["title"], "Durable new title")
                result = resumed.recover_pair(STOPPED)
                self.assertTrue(result["pair_ready"])
                self.assertEqual(api.calls.count("create"), 2)
            finally:
                resumed.close()

    def test_create_intent_survives_disk_reopen_without_duplicate(self):
        with tempfile.TemporaryDirectory(prefix="sc2tools-youtube-test-", dir=Path(__file__).resolve().parent) as directory:
            work = Path(directory).resolve()
            self.assertTrue(work.is_relative_to(Path(__file__).resolve().parent))
            api, clock = FakeGoogle(), Clock()
            api.fail_create = True
            backend = PairBackend(work, api=api, config=configuration(), writes_enabled=True, clock=clock)
            self.assertEqual(backend.prepare_pair(STOPPED)["code"], "creation_uncertain")
            backend.close()
            api.fail_create = False
            resumed = PairBackend(work, api=api, config=configuration(), writes_enabled=True, clock=clock)
            try:
                self.assertEqual(resumed.prepare_pair(STOPPED)["code"], "creation_uncertain")
                self.assertEqual(api.calls.count("create"), 1)
                state = json.loads((work / STATE_NAME).read_text())
                self.assertEqual(state["pair"]["entries"]["horizontal"]["phase"], "creation_uncertain")
            finally:
                resumed.close()


if __name__ == "__main__":
    unittest.main()
