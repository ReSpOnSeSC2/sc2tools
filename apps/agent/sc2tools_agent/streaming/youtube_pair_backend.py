"""Dock backend for a pre-bound pair of independent YouTube broadcasts.

No code runs at import. Google calls require an injected own-client API plus
explicit runtime configuration/write gates. No OBS, OAuth, browser, deletion,
key creation, RTMP start or automatic foreign-event adoption is implemented.
"""

import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import threading
import time
import uuid
from urllib.parse import urlencode

from .common import OCCUPIED, TERMINAL

SCOPES = ("horizontal", "portrait")
CONFIG_NAME = "youtube-button-helper.config.private.json"
STATE_NAME = "youtube-pair-backend.state.private.json"
TEMPLATE_NAME = "youtube-pair-template.json"
DESCRIPTION_LIMIT_BYTES = 5000
PARTNER_LINK_RESERVED_BYTES = 128
OPERATION_MARKER_RESERVED_BYTES = 64
IDLE_POLL_SECONDS = 900
SAFE_MESSAGES = {
    "ok": "Ready.",
    "authorization_required": "Connect your own YouTube authorization before preparing streams.",
    "runtime_disabled": "YouTube automation is disabled until setup is approved.",
    "writes_disabled": "Google changes are disabled.",
    "configuration_required": "Confirm the channel, distinct reusable keys, privacy and audience settings.",
    "outputs_unknown": "OBS output state is unknown. Wait for connection before preparing.",
    "outputs_active": "Stop both YouTube outputs before preparing the next pair.",
    "cloud_ingest_active": "YouTube still receives video. Wait for both inputs to stop.",
    "foreign_event_conflict": "An existing YouTube event uses a selected key. Preserve it and resolve the conflict first.",
    "api_unavailable": "YouTube could not be verified. Current event ownership is preserved.",
    "creation_uncertain": "Event creation needs review. No replacement event will be created automatically.",
    "binding_uncertain": "The owned event binding needs recovery before starting.",
    "ownership_changed": "An event or stream identity changed. Preparation is blocked.",
    "pair_not_complete": "The current pair has not ended. Reuse it or wait for completion.",
    "not_ready": "Both YouTube events must be verified ready before starting the existing Aitum buttons.",
    "metadata_invalid": "Use a nonempty title within 100 characters including the vertical suffix, and a description within 4808 UTF-8 bytes to leave room for the vertical partner link; angle brackets are not supported.",
    "metadata_pending": "The future template is saved. Current YouTube metadata is waiting for verification.",
    "metadata_save_failed": "The title could not be saved. Your previous title and description are preserved.",
    "template_saved": "The title and description are saved for your next YouTube pair.",
    "auto_stop_delayed": "YouTube has not confirmed both events ended. No new pair is being created.",
    "ready_not_live": "YouTube has not confirmed the prepared stream is live.",
    "outputs_without_pair": "YouTube outputs are active without a verified prepared pair.",
    "invalid_action": "Unknown dock action.",
    "review_required": "An uncertain creation must be reviewed before recovery can claim an event.",
}


class BackendError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(SAFE_MESSAGES.get(code, SAFE_MESSAGES["api_unavailable"]))


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


class ProcessLock:
    """Exclusive runtime-directory lock, released automatically on process exit."""
    def __init__(self, path):
        self.handle = Path(path).open("a+b")
        self.handle.seek(0)
        if not self.handle.read(1):
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                self.lock_module = msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                self.lock_module = fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise BackendError("runtime_disabled")

    def close(self):
        if not self.handle.closed:
            self.handle.seek(0)
            if os.name == "nt":
                self.lock_module.locking(self.handle.fileno(), self.lock_module.LK_UNLCK, 1)
            else:
                self.lock_module.flock(self.handle.fileno(), self.lock_module.LOCK_UN)
            self.handle.close()


def metadata_valid(value):
    if not isinstance(value, dict):
        raise BackendError("metadata_invalid")
    title, description, suffix = value.get("title"), value.get("description"), value.get("vertical_suffix")
    if not all(isinstance(item, str) for item in (title, description, suffix)):
        raise BackendError("metadata_invalid")
    try:
        if not title.strip() or len(title) > 100 or len(title + suffix) > 100 or len(description.encode("utf-8")) > DESCRIPTION_LIMIT_BYTES - PARTNER_LINK_RESERVED_BYTES - OPERATION_MARKER_RESERVED_BYTES:
            raise BackendError("metadata_invalid")
        (title + suffix).encode("utf-8", errors="strict")
    except UnicodeError:
        raise BackendError("metadata_invalid")
    if any("<" in item or ">" in item for item in (title, description, suffix)):
        raise BackendError("metadata_invalid")
    return {"title": title, "description": description, "vertical_suffix": suffix}


class PairBackend:
    def __init__(self, workdir, *, api=None, config=None, writes_enabled=False, connected=None, memory=False, clock=time.time, output_reader=None):
        self.workdir = Path(workdir)
        self.api = api
        self.writes_enabled = bool(writes_enabled)
        self.connected = api is not None if connected is None else bool(connected)
        self.memory, self.clock = memory, clock
        self.output_reader = output_reader
        self.mutex = threading.RLock()
        self.process_lock = None
        self.last_saved_state = None
        self.config_path = self.workdir / CONFIG_NAME
        self.state_path = self.workdir / STATE_NAME
        self.template_path = self.workdir / TEMPLATE_NAME
        if not memory:
            # Shared with the legacy observer: never run two Google lifecycle
            # implementations concurrently against the same reusable keys.
            self.process_lock = ProcessLock(self.workdir / "youtube-button-helper.lock")
        try:
            if config is None:
                path = self.config_path if self.config_path.exists() else self.workdir / "youtube-button-helper.config.example.json"
                config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            self.config = copy.deepcopy(config)
            default_title = self.config.get("streams", {}).get("horizontal", {}).get("title", "SC2 Live")
            metadata = self.config.get("metadata", {"title": default_title, "description": "", "vertical_suffix": " | Vertical"})
            if not memory and self.template_path.exists():
                metadata = json.loads(self.template_path.read_text(encoding="utf-8"))
            self.metadata = metadata_valid(metadata)
            self.config["metadata"] = copy.deepcopy(self.metadata)
            self.config.setdefault("runtime_enabled", False)
            self.config.setdefault("auto_rearm", False)
            self.state = json.loads(self.state_path.read_text(encoding="utf-8")) if not memory and self.state_path.exists() else {
                "version": 2, "pair": None, "metadata_revision": 0,
                "auto_rearm_armed": False, "last_outputs": {scope: None for scope in SCOPES},
                "next_poll": 0, "next_prepare_attempt": 0, "code": "ok",
                "metadata": copy.deepcopy(self.metadata), "cloud_verified": False,
            }
            if self.state.get("version") != 2:
                raise BackendError("review_required")
            if "metadata" in self.state:
                self.metadata = metadata_valid(self.state["metadata"])
                self.config["metadata"] = copy.deepcopy(self.metadata)
            else:
                self.state["metadata"] = copy.deepcopy(self.metadata)
            self.state.setdefault("cloud_verified", False)
            # Persisted ownership remains, but a new process must reverify the
            # account/bindings before advertising Ready or verified watch URLs.
            self.state["cloud_verified"] = False
            self.state["next_poll"] = 0
            if not memory and self.state_path.exists():
                self.last_saved_state = json.dumps(self.state, sort_keys=True)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.process_lock:
            self.process_lock.close()

    def _save(self):
        serialized = json.dumps(self.state, sort_keys=True)
        if not self.memory and serialized != self.last_saved_state:
            atomic_json(self.state_path, self.state)
            self.last_saved_state = serialized

    def _save_template(self):
        self.config["metadata"] = copy.deepcopy(self.metadata)
        if not self.memory:
            atomic_json(self.template_path, self.metadata)
            # Do not rewrite a stale private config while separate OAuth
            # discovery may be pinning new IDs. Metadata+revision are durable in
            # state, and this template is a derived UI/future-session copy.

    def reset_poll_backoff(self):
        """Allow prompt read verification after explicit account reconnection."""
        with self.mutex:
            self.state.update(poll_failures=0, poll_not_before=0, next_poll=0)
            self._save()

    def _poll_success(self):
        self.state.update(poll_failures=0, poll_not_before=0)

    def _poll_failure(self, error):
        failures = min(8, self.state.get("poll_failures", 0) + 1)
        status = getattr(error, "http_status", getattr(error, "status", None))
        code = getattr(error, "code", "")
        delay = 1800 if status == 429 else 900 if status in {401, 403} or code in {"creation_uncertain", "binding_uncertain", "ownership_changed", "foreign_event_conflict"} else min(900, 30 * 2 ** (failures - 1))
        self.state.update(poll_failures=failures, poll_not_before=self.clock() + delay, next_poll=self.clock() + delay)

    def _error(self, code):
        self.state["code"] = code
        if code in {"api_unavailable", "ownership_changed", "foreign_event_conflict", "creation_uncertain", "binding_uncertain"}:
            self.state["cloud_verified"] = False
        try:
            self._save()
        except OSError:
            pass  # A diagnostic-write failure must not claim an action saved.
        return self.public_status(ok=False, code=code)

    def _gate(self):
        if not self.api or not self.connected:
            raise BackendError("authorization_required")
        if not self.writes_enabled:
            raise BackendError("writes_disabled")
        if hasattr(self.api, "write_enabled") and self.api.write_enabled is not True:
            raise BackendError("writes_disabled")
        if self.config.get("runtime_enabled") is not True:
            raise BackendError("runtime_disabled")
        scopes = self.config.get("streams", {})
        if self.config.get("mode") != "separate-events" or self.config.get("user_approved_separate_events") is not True or self.config.get("existing_reusable_keys_confirmed") is not True or not self.config.get("expected_channel_id") or set(scopes) != set(SCOPES):
            raise BackendError("configuration_required")
        ids = []
        for scope in SCOPES:
            setting = scopes[scope]
            ids.append(setting.get("reusable_stream_id"))
            if not ids[-1] or setting.get("privacy") not in {"private", "unlisted", "public"} or not isinstance(setting.get("made_for_kids"), bool):
                raise BackendError("configuration_required")
        if ids[0] == ids[1]:
            raise BackendError("configuration_required")

    @staticmethod
    def _outputs(outputs, require_stopped=False):
        if not isinstance(outputs, dict) or any(not isinstance(outputs.get(scope), bool) for scope in SCOPES):
            raise BackendError("outputs_unknown")
        if require_stopped and any(outputs[scope] for scope in SCOPES):
            raise BackendError("outputs_active")
        return {scope: outputs[scope] for scope in SCOPES}

    def _stream_ids(self):
        return [self.config["streams"][scope]["reusable_stream_id"] for scope in SCOPES]

    def _verify_streams(self, require_stopped):
        rows = self.api.streams_by_ids(self._stream_ids())
        for stream_id in self._stream_ids():
            matches = [row for row in rows if row.get("id") == stream_id]
            if len(matches) != 1 or matches[0].get("snippet", {}).get("channelId") != self.config["expected_channel_id"]:
                raise BackendError("ownership_changed")
            status = matches[0].get("status", {}).get("streamStatus")
            if status not in {"active", "created", "ready", "inactive", "error"}:
                raise BackendError("api_unavailable")
            if require_stopped and status not in {"created", "ready", "inactive"}:
                raise BackendError("cloud_ingest_active")

    def _before_prepare_write(self):
        """Recheck immediately before every non-idempotent create/bind.

        Native Aitum buttons cannot be locked by this controller. The final
        fresh local read narrows the race while the UI requires waiting for
        Ready; it cannot make Google and native output changes atomic.
        """
        self._gate()
        self._verify_streams(True)
        self._check_conflicts()
        if self.output_reader is not None:
            try:
                outputs = self.output_reader()
            except Exception:
                raise BackendError("outputs_unknown")
            self._outputs(outputs, True)

    def _entries(self):
        return self.state.get("pair", {}).get("entries", {}) if self.state.get("pair") else {}

    def _owned_row(self, scope, entry, row, allow_unbound=False):
        if row.get("id") != entry.get("broadcast_id") or row.get("snippet", {}).get("channelId") != self.config["expected_channel_id"] or entry.get("stream_id") != self.config["streams"][scope]["reusable_stream_id"]:
            raise BackendError("ownership_changed")
        if not isinstance(row.get("contentDetails"), dict):
            raise BackendError("api_unavailable")
        bound = row["contentDetails"].get("boundStreamId")
        if bound != entry["stream_id"] and not (allow_unbound and not bound):
            raise BackendError("ownership_changed")
        status = row.get("status", {}).get("lifeCycleStatus")
        if status not in OCCUPIED | TERMINAL:
            raise BackendError("api_unavailable")
        return status

    def _check_conflicts(self):
        entries = self._entries()
        owned = {entry["broadcast_id"]: entry["stream_id"] for scope, entry in entries.items() if entry.get("broadcast_id") and entry.get("stream_id") == self.config["streams"][scope]["reusable_stream_id"]}
        counts = {}
        rows = self.api.occupied_broadcasts() if hasattr(self.api, "occupied_broadcasts") else self.api.all_owned_broadcasts()
        for row in rows:
            details = row.get("contentDetails")
            if not isinstance(details, dict):
                raise BackendError("api_unavailable")
            stream_id = details.get("boundStreamId")
            if stream_id not in self._stream_ids():
                continue
            if row.get("snippet", {}).get("channelId") != self.config["expected_channel_id"]:
                raise BackendError("ownership_changed")
            status = row.get("status", {}).get("lifeCycleStatus")
            if status not in OCCUPIED | TERMINAL:
                raise BackendError("api_unavailable")
            if status in OCCUPIED:
                counts[stream_id] = counts.get(stream_id, 0) + 1
                if counts[stream_id] > 1 or owned.get(row.get("id")) != stream_id:
                    raise BackendError("foreign_event_conflict")

    def _desired_description(self, scope):
        description = self.metadata["description"]
        if scope == "portrait":
            horizontal = self._entries().get("horizontal", {})
            broadcast_id = horizontal.get("broadcast_id")
            if not isinstance(broadcast_id, str) or not broadcast_id or horizontal.get("stream_id") != self.config["streams"]["horizontal"]["reusable_stream_id"]:
                raise BackendError("not_ready")
            # Use only this session's owned horizontal ID, never a configured
            # old URL, and quote it as a query value before composing the link.
            url = "https://www.youtube.com/watch?" + urlencode({"v": broadcast_id})
            description = "Watch the horizontal stream: " + url + "\n\n" + description
        if len(description.encode("utf-8")) > DESCRIPTION_LIMIT_BYTES:
            raise BackendError("metadata_invalid")
        return description

    def _desired_metadata(self, scope):
        return {
            "title": self.metadata["title"] + (self.metadata["vertical_suffix"] if scope == "portrait" else ""),
            "description": self._desired_description(scope),
        }

    def _body(self, scope):
        setting = self.config["streams"][scope]
        desired = self._desired_metadata(scope)
        scheduled = datetime.fromtimestamp(self.clock(), timezone.utc) + timedelta(seconds=60)
        return {
            "snippet": {**desired, "categoryId": "20", "scheduledStartTime": scheduled.isoformat().replace("+00:00", "Z")},
            "status": {"privacyStatus": setting["privacy"], "selfDeclaredMadeForKids": setting["made_for_kids"]},
            "contentDetails": {"enableAutoStart": True, "enableAutoStop": True, "monitorStream": {"enableMonitorStream": False}},
        }

    def _bind(self, scope, entry):
        self._before_prepare_write()
        entry["phase"] = "binding"
        self._save()
        try:
            result = self.api.bind_broadcast(entry["broadcast_id"], entry["stream_id"])
            status = self._owned_row(scope, entry, result)
        except Exception:
            entry["phase"] = "binding_uncertain"
            self._save()
            raise BackendError("binding_uncertain")
        entry.update(phase="bound", lifecycle=status)
        self._save()

    def _recover_known(self):
        entries = self._entries()
        ids = [entry["broadcast_id"] for entry in entries.values() if entry.get("broadcast_id")]
        rows = self.api.broadcasts_by_ids(ids) if ids else []
        by_id = {row["id"]: row for row in rows}
        for scope, entry in entries.items():
            if not entry.get("broadcast_id"):
                continue
            row = by_id.get(entry["broadcast_id"])
            if row is None:
                raise BackendError("ownership_changed")
            status = self._owned_row(scope, entry, row, allow_unbound=entry["phase"] in {"created", "binding", "binding_uncertain"})
            entry["lifecycle"] = status
            details = row["contentDetails"]
            entry["auto_start_stop_verified"] = details.get("enableAutoStart") is True and details.get("enableAutoStop") is True and details.get("monitorStream", {}).get("enableMonitorStream") is False
            if status in TERMINAL:
                entry["phase"] = "terminal"
            elif row["contentDetails"].get("boundStreamId") == entry["stream_id"]:
                entry["phase"] = "bound"
            elif status == "created" and entry["phase"] in {"created", "binding", "binding_uncertain"}:
                self._bind(scope, entry)
            else:
                raise BackendError("ownership_changed")
        self._save()

    def _uncertain_candidates(self, scope, entry):
        body = entry.get("create_body", {})
        expected = body.get("snippet", {})
        candidates = []
        for row in self.api.all_owned_broadcasts():
            snippet = row.get("snippet", {})
            if snippet.get("channelId") == self.config["expected_channel_id"] and all(snippet.get(key, "") == expected.get(key, "") for key in ("title", "description", "scheduledStartTime")):
                candidates.append(row["id"])
        entry["recovery_candidates"] = candidates[:5]
        self._save()
        # Matching metadata cannot prove which client created an event. Require
        # explicit review rather than automatic adoption or duplicate insertion.
        raise BackendError("creation_uncertain")

    def _recover_remote_create(self, scope, entry):
        operation_id = entry.get("operation_id")
        if not operation_id or not callable(getattr(self.api, "recover_create", None)):
            raise BackendError("creation_uncertain")
        # Only the trusted facade can reconcile its durable private nonce. Do
        # not normalize descriptions or adopt a title match from broad lists.
        row = self.api.recover_create(operation_id)
        body = entry.get("create_body", {})
        expected = body.get("snippet", {})
        snippet = row.get("snippet", {}) if isinstance(row, dict) else {}
        details = row.get("contentDetails", {}) if isinstance(row, dict) else {}
        status = row.get("status", {}) if isinstance(row, dict) else {}
        try:
            dates = [datetime.fromisoformat(value.replace("Z", "+00:00")) for value in (snippet.get("scheduledStartTime", ""), expected.get("scheduledStartTime", ""))]
            same_time = all(value.tzinfo is not None for value in dates) and dates[0] == dates[1]
        except (TypeError, ValueError):
            same_time = False
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"] or snippet.get("channelId") != self.config["expected_channel_id"] or not same_time or any(snippet.get(key, "") != expected.get(key, "") for key in ("title", "description")) or "categoryId" in expected and snippet.get("categoryId") != expected["categoryId"] or any(status.get(key) != body.get("status", {}).get(key) for key in ("privacyStatus", "selfDeclaredMadeForKids")) or details.get("enableAutoStart") is not True or details.get("enableAutoStop") is not True or details.get("monitorStream", {}).get("enableMonitorStream") is not False:
            raise BackendError("ownership_changed")
        entry.update(phase="created", broadcast_id=row["id"])
        entry.pop("recovery_candidates", None)
        self._save()

    def prepare_pair(self, outputs):
        with self.mutex:
            try:
                self._gate()
                self.state["last_outputs"] = self._outputs(outputs, True)
                self._verify_streams(True)
                self._check_conflicts()
                pair = self.state.get("pair")
                if pair:
                    if any(entry.get("phase") in {"creating", "creation_uncertain"} and not entry.get("broadcast_id") for entry in pair["entries"].values()):
                        scope = next(scope for scope, entry in pair["entries"].items() if entry.get("phase") in {"creating", "creation_uncertain"} and not entry.get("broadcast_id"))
                        self._uncertain_candidates(scope, pair["entries"][scope])
                    self._recover_known()
                    self._sync_metadata()
                    self._refresh(False)
                    pair = self.state["pair"]
                    if self._is_ready():
                        if self.output_reader is not None:
                            try:
                                fresh = self.output_reader()
                            except Exception:
                                raise BackendError("outputs_unknown")
                            self.state["last_outputs"] = self._outputs(fresh, True)
                        # A brief local send may never have started the cloud
                        # event. Fresh stopped inputs + two verified ready
                        # events allow explicit reuse of the same owned pair.
                        pair.pop("started_at", None)
                        pair.pop("stopped_at", None)
                        self._poll_success()
                        self.state.update(code="ok", auto_rearm_armed=True, next_poll=self.clock() + IDLE_POLL_SECONDS)
                        self.state["pair"]["phase"] = "ready"
                        self._save()
                        return self.public_status()
                    if all(pair["entries"].get(scope, {}).get("phase") == "terminal" for scope in SCOPES):
                        self.state["pair"] = None
                        pair = None
                    elif any(entry.get("phase") == "terminal" for entry in pair["entries"].values()):
                        raise BackendError("pair_not_complete")
                    elif any(entry.get("lifecycle") in {"testing", "testStarting", "live", "liveStarting"} for entry in pair["entries"].values()):
                        raise BackendError("pair_not_complete")
                if not pair:
                    self.state["pair"] = {"session": uuid.uuid4().hex, "created_at": self.clock(), "entries": {}, "phase": "preparing"}
                    self._save()
                for scope in SCOPES:
                    entries = self._entries()
                    if scope in entries:
                        continue
                    # A rejected fresh read leaves no uncertain create intent:
                    # no POST has been attempted and the partial pair can resume.
                    self._before_prepare_write()
                    body = self._body(scope)
                    entry = {"phase": "creating", "stream_id": self.config["streams"][scope]["reusable_stream_id"], "create_body": body, "operation_id": str(uuid.uuid4()), "created_at": self.clock(), "metadata_revision": self.state["metadata_revision"]}
                    entries[scope] = entry
                    self._save()  # Intent before the non-idempotent POST.
                    try:
                        if getattr(self.api, "requires_operation_id", False) is True:
                            created = self.api.create_broadcast(body, operation_id=entry["operation_id"])
                        else:
                            created = self.api.create_broadcast(body)
                    except Exception:
                        entry["phase"] = "creation_uncertain"
                        self._save()
                        raise BackendError("creation_uncertain")
                    if not created.get("id") or created.get("snippet", {}).get("channelId") != self.config["expected_channel_id"]:
                        entry["phase"] = "creation_uncertain"
                        self._save()
                        raise BackendError("ownership_changed")
                    entry.update(phase="created", broadcast_id=created["id"])
                    self._save()  # Own ID durable before bind.
                    self._bind(scope, entry)
                self._refresh(False)
                if not self._is_ready():
                    raise BackendError("not_ready")
                self._poll_success()
                self.state.update(auto_rearm_armed=True, code="ok", next_poll=self.clock() + IDLE_POLL_SECONDS)
                self.state["pair"]["phase"] = "ready"
                self._save()
                return self.public_status()
            except BackendError as error:
                self._poll_failure(error)
                return self._error(error.code)
            except Exception as error:
                self._poll_failure(error)
                return self._error("api_unavailable")

    def _refresh(self, active):
        entries = self._entries()
        ids = [entry["broadcast_id"] for entry in entries.values() if entry.get("broadcast_id")]
        if len(ids) != len(entries):
            raise BackendError("creation_uncertain")
        rows = self.api.broadcasts_by_ids(ids) if ids else []
        by_id = {row["id"]: row for row in rows}
        for scope, entry in entries.items():
            row = by_id.get(entry["broadcast_id"])
            if row is None:
                raise BackendError("ownership_changed")
            status = self._owned_row(scope, entry, row)
            entry["lifecycle"] = status
            entry["phase"] = "terminal" if status in TERMINAL else "bound"
            details = row["contentDetails"]
            entry["auto_start_stop_verified"] = details.get("enableAutoStart") is True and details.get("enableAutoStop") is True and details.get("monitorStream", {}).get("enableMonitorStream") is False
            entry["remote_metadata"] = {"title": row.get("snippet", {}).get("title", ""), "description": row.get("snippet", {}).get("description", "")}
            entry["server_metadata_pending"] = row.get("metadataPending") is True
            expected_category = entry.get("create_body", {}).get("snippet", {}).get("categoryId")
            entry["category_verified"] = expected_category is None or row.get("snippet", {}).get("categoryId") == expected_category
        self.state["cloud_verified"] = True
        pair = self.state.get("pair")
        if pair:
            if len(entries) == 2 and all(entry.get("phase") == "terminal" for entry in entries.values()):
                pair["phase"] = "complete"
            elif active:
                pair["phase"] = "live" if any(entry.get("lifecycle") == "live" for entry in entries.values()) else "starting"
            elif pair.get("started_at"):
                pair["phase"] = "stopping"
            else:
                pair["phase"] = "ready" if self._is_ready() else "preparing"
        self._save()

    def _is_ready(self):
        entries = self._entries()
        return self.state.get("cloud_verified") is True and set(entries) == set(SCOPES) and all(
            entry.get("phase") == "bound" and entry.get("lifecycle") == "ready"
            and entry.get("auto_start_stop_verified") is True
            and entry.get("metadata_revision") == self.state["metadata_revision"]
            and entry.get("server_metadata_pending") is not True
            and entry.get("category_verified") is True
            and entry.get("remote_metadata") == self._desired_metadata(scope)
            for scope, entry in entries.items()
        )

    def arm_start(self, outputs):
        with self.mutex:
            try:
                self._gate()
                self._outputs(outputs, True)
                self._verify_streams(True)
                self._check_conflicts()
                self._refresh(False)
                if not self._is_ready():
                    raise BackendError("not_ready")
                self.state["code"] = "ok"
                self._save()
                return self.public_status()
            except BackendError as error:
                return self._error(error.code)
            except Exception as error:
                return self._error("api_unavailable")

    def verify_future_configuration(self, candidate, outputs):
        """Read-only gate for future settings of the same channel and keys.

        A completed pair remains owned in state and in YouTube. This method
        performs no API writes or state/config writes; the caller persists the
        candidate only after success, under its service operation lock.
        """
        with self.mutex:
            self._outputs(outputs, True)
            if not self.state.get("pair"):
                return True
            self._gate()
            if not isinstance(candidate, dict) or candidate.get("expected_channel_id") != self.config["expected_channel_id"]:
                raise BackendError("configuration_required")
            streams = candidate.get("streams", {})
            if not isinstance(streams, dict) or set(streams) != set(SCOPES) or any(
                not isinstance(streams[scope], dict)
                or streams[scope].get("reusable_stream_id") != self.config["streams"][scope]["reusable_stream_id"]
                for scope in SCOPES
            ):
                raise BackendError("configuration_required")
            entries = self._entries()
            if set(entries) != set(SCOPES) or any(not entry.get("broadcast_id") for entry in entries.values()):
                raise BackendError("pair_not_complete")
            self._verify_streams(True)
            self._check_conflicts()
            rows = self.api.broadcasts_by_ids([entries[scope]["broadcast_id"] for scope in SCOPES])
            by_id = {row.get("id"): row for row in rows}
            if len(rows) != len(SCOPES) or len(by_id) != len(SCOPES):
                raise BackendError("ownership_changed")
            for scope, entry in entries.items():
                row = by_id.get(entry["broadcast_id"])
                if row is None:
                    raise BackendError("ownership_changed")
                if self._owned_row(scope, entry, row) not in TERMINAL:
                    raise BackendError("pair_not_complete")
            # Last local read follows the cloud requests. Native button actions
            # cannot be made atomic with this check or local config persistence.
            if self.output_reader is not None:
                try:
                    fresh = self.output_reader()
                except Exception:
                    raise BackendError("outputs_unknown")
                self._outputs(fresh, True)
            return True

    def _sync_metadata(self):
        entries = self._entries()
        for scope, entry in entries.items():
            if not entry.get("broadcast_id") or entry.get("phase") == "terminal":
                continue
            desired = self._desired_metadata(scope)
            if entry.get("metadata_revision") == self.state["metadata_revision"] and entry.get("remote_metadata") == desired and entry.get("server_metadata_pending") is not True:
                continue
            row = self.api.broadcast_by_id(entry["broadcast_id"])
            status = self._owned_row(scope, entry, row)
            if status in TERMINAL:
                entry.update(phase="terminal", lifecycle=status)
                continue
            title = desired["title"]
            entry["metadata_update_intent"] = {"revision": self.state["metadata_revision"], **desired}
            self._save()
            actual = {"title": row.get("snippet", {}).get("title", ""), "description": row.get("snippet", {}).get("description", "")}
            if actual != desired or row.get("metadataPending") is True or entry.get("server_metadata_pending") is True:
                self.api.update_video_metadata(entry["broadcast_id"], title, desired["description"], self.config["expected_channel_id"])
            entry["metadata_revision"] = self.state["metadata_revision"]
            entry["remote_metadata"] = copy.deepcopy(desired)
            entry["server_metadata_pending"] = False
            entry.pop("metadata_update_intent", None)
            if entry.get("create_body"):
                entry["create_body"]["snippet"].update(desired)
            self._save()

    def set_metadata(self, title, description, vertical_suffix=None):
        with self.mutex:
            before_metadata = copy.deepcopy(self.metadata)
            before_state = copy.deepcopy(self.state)
            before_config_metadata = copy.deepcopy(self.config.get("metadata"))
            before_saved = self.last_saved_state
            primary_committed = False
            try:
                value = metadata_valid({"title": title, "description": description, "vertical_suffix": self.metadata["vertical_suffix"] if vertical_suffix is None else vertical_suffix})
                if value != self.metadata:
                    self.metadata = value
                    self.state["metadata_revision"] += 1
                    self.state["metadata"] = copy.deepcopy(value)
                self._save()
                primary_committed = True
                self._save_template()
                if not self._entries():
                    result = self.public_status(code="template_saved")
                    result["future_template_saved"] = True
                    return result
                try:
                    self._gate()
                except BackendError:
                    result = self.public_status(code="metadata_pending")
                    result["future_template_saved"] = True
                    return result
                self._sync_metadata()
                if self.state.get("pair") and not self.state["pair"].get("started_at") and self._is_ready():
                    self.state["pair"]["phase"] = "ready"
                self.state["code"] = "ok"
                self._save()
                result = self.public_status()
                result["future_template_saved"] = True
                return result
            except BackendError as error:
                result = self._error(error.code)
                result["future_template_saved"] = primary_committed
                return result
            except Exception as error:
                if not primary_committed and not self.memory:
                    # A writer can report failure after replacement. Verify the
                    # durable primary before deciding whether rollback is safe.
                    try:
                        primary_committed = json.loads(self.state_path.read_text(encoding="utf-8")) == self.state
                    except (OSError, ValueError):
                        primary_committed = False
                if not primary_committed:
                    self.metadata = before_metadata
                    self.state = before_state
                    self.config["metadata"] = before_config_metadata
                    self.last_saved_state = before_saved
                    # Do not attempt another write to the failing store.
                    result = self.public_status(ok=False, code="metadata_save_failed")
                    result["future_template_saved"] = False
                    return result
                # The primary metadata+revision is authoritative. A derived
                # template/API failure must retain the committed new values.
                self._poll_failure(error)
                result = self._error("metadata_pending")
                result["future_template_saved"] = True
                return result

    def recover_pair(self, outputs):
        with self.mutex:
            try:
                self._gate()
                self._outputs(outputs, True)
                self._verify_streams(True)
                self._check_conflicts()
                for scope, entry in self._entries().items():
                    if entry.get("phase") in {"creating", "creation_uncertain"} and not entry.get("broadcast_id"):
                        if getattr(self.api, "requires_operation_id", False) is True:
                            self._recover_remote_create(scope, entry)
                        else:
                            self._uncertain_candidates(scope, entry)
                self._recover_known()
                self._sync_metadata()
                return self.prepare_pair(outputs)
            except BackendError as error:
                return self._error(error.code)
            except Exception:
                return self._error("api_unavailable")

    def runtime_tick(self, outputs):
        with self.mutex:
            poll_attempted = False
            try:
                states = self._outputs(outputs)
                self.state["last_outputs"] = states
                self._gate()
                pair = self.state.get("pair")
                if not pair:
                    if any(states.values()):
                        raise BackendError("outputs_without_pair")
                    return self.public_status()
                if any(states.values()) and pair.get("phase") in {"preparing", "complete"}:
                    raise BackendError("outputs_without_pair")
                now = self.clock()
                if any(states.values()) and not pair.get("started_at"):
                    pair["started_at"] = now
                    self.state["next_poll"] = 0
                if not any(states.values()) and pair.get("started_at") and not pair.get("stopped_at"):
                    pair["stopped_at"] = now
                    self.state["next_poll"] = 0
                elif any(states.values()) and pair.get("stopped_at"):
                    pair.pop("stopped_at", None)
                    self.state["next_poll"] = 0
                if now >= max(self.state.get("next_poll", 0), self.state.get("poll_not_before", 0)):
                    poll_attempted = True
                    self._check_conflicts()
                    self._refresh(any(states.values()))
                    self._sync_metadata()
                    pair = self.state["pair"]
                    if not pair.get("started_at") and self._is_ready():
                        pair["phase"] = "ready"
                    self._poll_success()
                    self.state["next_poll"] = now + (5 if pair["phase"] == "stopping" else 60 if pair["phase"] == "live" else 10 if pair["phase"] == "starting" else 30 if pair["phase"] == "preparing" else IDLE_POLL_SECONDS)
                pair = self.state["pair"]
                if pair.get("stopped_at") and pair["phase"] != "complete" and now - pair["stopped_at"] > 180:
                    raise BackendError("auto_stop_delayed")
                if pair.get("started_at") and any(states.values()) and pair["phase"] == "starting" and now - pair["started_at"] > 120:
                    raise BackendError("ready_not_live")
                if pair["phase"] == "complete" and not any(states.values()) and self.config.get("auto_rearm") is True and self.state.get("auto_rearm_armed") and now >= max(self.state.get("next_prepare_attempt", 0), self.state.get("poll_not_before", 0)):
                    self.state["next_prepare_attempt"] = now + 30
                    self._save()
                    return self.prepare_pair(states)
                if self.state.get("cloud_verified") is True:
                    self.state["code"] = "ok"
                self._save()
                return self.public_status()
            except BackendError as error:
                if poll_attempted:
                    self._poll_failure(error)
                return self._error(error.code)
            except Exception as error:
                self._poll_failure(error)
                return self._error("api_unavailable")

    def public_status(self, *, ok=True, code=None):
        with self.mutex:
            code = code or self.state.get("code", "ok")
            if not self.connected or not self.api:
                phase = "authorization_required"
                if code == "ok":
                    code = "authorization_required"
            elif not self.writes_enabled or not self.config.get("runtime_enabled"):
                phase = "disabled"
            else:
                phase = self.state["pair"]["phase"] if self.state.get("pair") else "idle"
            channels = {}
            pair = self.state.get("pair") or {}
            observed = self.state.get("last_outputs", {})
            prepared = self._is_ready()
            for scope in SCOPES:
                entry = self._entries().get(scope, {})
                lifecycle = entry.get("lifecycle")
                display_phase = entry.get("phase", "idle")
                if lifecycle in TERMINAL:
                    display_phase = "complete"
                elif observed.get(scope) is True:
                    display_phase = "live" if lifecycle == "live" else "starting"
                elif pair.get("phase") == "stopping":
                    display_phase = "stopping"
                elif lifecycle in {"testing", "testStarting", "liveStarting"}:
                    display_phase = "starting"
                elif lifecycle == "live":
                    display_phase = "live"
                elif display_phase == "bound":
                    display_phase = "ready" if prepared and code == "ok" else "blocked"
                channels[scope] = {
                    "phase": entry.get("phase", "idle"), "lifecycle": entry.get("lifecycle"),
                    "display_phase": display_phase,
                    "title": self.metadata["title"] + (self.metadata["vertical_suffix"] if scope == "portrait" else ""),
                    "metadata_pending": bool(entry.get("broadcast_id") and entry.get("phase") != "terminal" and (entry.get("metadata_revision") != self.state["metadata_revision"] or entry.get("server_metadata_pending") is True)),
                    "recovery_candidate_count": len(entry.get("recovery_candidates", [])),
                }
            ready = prepared and pair.get("phase") == "ready" and not pair.get("started_at") and not any(value is True for value in observed.values()) and code == "ok" and self.connected and self.writes_enabled and self.config.get("runtime_enabled") is True
            watch_urls = {
                scope: "https://www.youtube.com/watch?" + urlencode({"v": entry["broadcast_id"]})
                for scope, entry in self._entries().items()
                if self.state.get("cloud_verified") is True and entry.get("broadcast_id")
                and entry.get("stream_id") == self.config.get("streams", {}).get(scope, {}).get("reusable_stream_id")
            }
            return {
                "ok": bool(ok), "code": code, "phase": phase,
                "connected": bool(self.connected and self.api), "auth_required": not bool(self.connected and self.api),
                "google_writes_enabled": self.writes_enabled, "runtime_enabled": self.config.get("runtime_enabled") is True,
                "auto_rearm_enabled": self.config.get("auto_rearm") is True and self.state.get("auto_rearm_armed") is True,
                "pair_ready": bool(ready), "metadata": copy.deepcopy(self.metadata), "channels": channels,
                "watch_urls": watch_urls,
                "separate_links_and_chats": True, "messages": [SAFE_MESSAGES.get(code, SAFE_MESSAGES["api_unavailable"])],
            }

    def dispatch(self, payload, outputs=None):
        with self.mutex:
            if not isinstance(payload, dict):
                return self._error("invalid_action")
            action = payload.get("action", "status")
            if action == "status":
                return self.public_status()
            if action == "set_metadata":
                return self.set_metadata(payload.get("title"), payload.get("description", ""), payload.get("vertical_suffix"))
            if action == "prepare":
                return self.prepare_pair(outputs)
            if action == "arm_start":
                return self.arm_start(outputs)
            if action == "observe":
                return self.runtime_tick(outputs)
            if action == "recover":
                return self.recover_pair(outputs)
            return self._error("invalid_action")


class PairObserver:
    """Long-running observer with bounded per-tick work and cooperative stop.

    Root supplies read-only output_reader and publishes public_status to the
    dock. No duration cap, no automatic startup installation, no RTMP mutation.
    """
    def __init__(self, backend, output_reader, interval=2):
        self.backend, self.output_reader = backend, output_reader
        self.interval = max(1, min(10, float(interval)))
        self.stop_event = threading.Event()
        self.thread = None

    def _run(self):
        while not self.stop_event.is_set():
            try:
                outputs = self.output_reader()
            except Exception:
                outputs = {scope: None for scope in SCOPES}
            self.backend.runtime_tick(outputs)
            self.stop_event.wait(self.interval)

    def start(self):
        if not self.thread or not self.thread.is_alive():
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._run, name="youtube-pair-observer", daemon=True)
            self.thread.start()

    def stop(self, timeout=5):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=max(0, min(30, timeout)))
        return not self.thread or not self.thread.is_alive()
