"""Bounded, local-only transport for one paused-simulation neural session.

Only canonical JSON observation frames cross this boundary. Immutable numbered
requests/replies bind a single worker, player, checkpoint and exact live frame.
No sockets, replay readers, optimizer, or native game controls live here.
"""
from __future__ import annotations

import asyncio
import errno
import json
import math
import os
from pathlib import Path
import re
import time
import uuid

from .policy_intents import bind_observation, canonical_sha256, prediction_to_intent

SESSION_SCHEMA = "alphastar-live-session-v1"
REQUEST_SCHEMA = "alphastar-live-request-v1"
RESPONSE_SCHEMA = "alphastar-live-response-v1"
WORKER_SCHEMA = "alphastar-live-worker-v1"
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_TIMEOUT = 600
MAX_SEQUENCE = 999999
FRAME_KEYS = {"schema", "game_loop", "camera", "hud", "alerts", "entities", "known_own", "selection",
              "selection_complete", "ui", "spatial", "available_abilities", "feature_layers", "own_upgrades",
              "known_neutral", "intervening_selection_input"}


class SpoolError(ValueError):
    pass


def _token(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{15,79}", value):
        raise SpoolError(f"Invalid {name}")
    return value


def _digest(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise SpoolError(f"Invalid {name}")
    return value


def _integer(value, name, minimum=0, maximum=2**31 - 1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise SpoolError(f"Invalid {name}")
    return value


def _timestamp(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise SpoolError(f"Invalid {name}")
    return value


def _root(directory):
    original = Path(directory)
    if original.is_symlink():
        raise SpoolError("Session directory may not be a symlink")
    root = original.resolve()
    if not root.is_dir():
        raise SpoolError("Prepared session directory is required")
    return root


def spool_path(directory, name):
    root = _root(directory)
    if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,110}", name)
            or name in (".", "..")):
        raise SpoolError("Unsafe spool filename")
    path = root / name
    if path.is_symlink() or path.resolve().parent != root:
        raise SpoolError("Spool path escapes prepared session")
    return path


def numbered_path(directory, kind, sequence):
    if kind not in ("request", "response"):
        raise SpoolError("Unknown spool record kind")
    _integer(sequence, "sequence", 1, MAX_SEQUENCE)
    return spool_path(directory, f"{kind}-{sequence:06d}.json")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise SpoolError("Duplicate JSON key")
        result[key] = value
    return result


def read_json(path, *, limit=MAX_JSON_BYTES):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise SpoolError("Missing, linked or oversized JSON record")
    blob = path.read_bytes()
    if len(blob) > limit:
        raise SpoolError("JSON record grew beyond byte limit")
    try:
        result = json.loads(blob, object_pairs_hook=_pairs,
                            parse_constant=lambda token: (_ for _ in ()).throw(SpoolError("Nonfinite JSON")))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise SpoolError("Invalid JSON record") from exc
    if not isinstance(result, dict):
        raise SpoolError("JSON envelope must be an object")
    return result


def file_identity(path):
    info = Path(path).stat()
    return info.st_size, info.st_mtime_ns, info.st_ctime_ns


async def read_worker_status(path, *, deadline_unix, stop_check, max_attempts=8, retry_delay=.025):
    """Retry only Windows sharing/access-denied races on mutable status.

    Windows/DrvFS can surface replacement contention as EACCES without a
    winerror. A permanent denial still fails after at most eight attempts.
    Immutable frames, JSON errors and other I/O failures are never retried.
    """
    path = Path(path)
    if path.name != "worker-status.json" or not 1 <= max_attempts <= 8 or not 0 <= retry_delay <= .025:
        raise SpoolError("Invalid bounded worker status retry")
    for attempt in range(max_attempts):
        stop_check()
        if time.time() > deadline_unix:
            raise SpoolError("Live inference deadline exceeded during status read")
        try:
            result = read_json(path, limit=MAX_RESPONSE_BYTES)
        except PermissionError as exc:
            winerror = getattr(exc, "winerror", None)
            sharing = (winerror in (5, 32, 33) or winerror is None and exc.errno == errno.EACCES)
            if not sharing or attempt + 1 == max_attempts:
                raise
            remaining = deadline_unix - time.time()
            if remaining <= 0:
                raise SpoolError("Live inference deadline exceeded during status retry") from exc
            await asyncio.sleep(min(retry_delay, remaining))
        else:
            stop_check()
            if time.time() > deadline_unix:
                raise SpoolError("Live inference deadline exceeded after status read")
            return result
    raise AssertionError("Bounded status retry exhausted without result or exception")


def atomic_json(path, value, *, replace=False, limit=MAX_JSON_BYTES):
    """Publish a complete record. Hard-link admission cannot overwrite a peer."""
    path = Path(path)
    if path.is_symlink() or not path.parent.is_dir():
        raise SpoolError("Unsafe output path")
    blob = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(blob) > limit:
        raise SpoolError("JSON output exceeds byte limit")
    pending = path.with_name(path.name + "." + uuid.uuid4().hex + ".pending")
    try:
        with pending.open("xb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(pending, path)
        else:
            os.link(pending, path)
    finally:
        if pending.exists():
            pending.unlink()


def sealed(record, field):
    if field in record:
        raise SpoolError("Hash field already present")
    return {**record, field: canonical_sha256(record)}


def verify_seal(record, field):
    expected = _digest(record.get(field), field)
    if canonical_sha256({key: value for key, value in record.items() if key != field}) != expected:
        raise SpoolError(f"Changed {field}")


def create_session(directory, session_id, checkpoint_sha256, catalog, *, player_id=1):
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    record = sealed({"schema": SESSION_SCHEMA, "session_id": _token(session_id, "session_id"),
                     "player_id": _integer(player_id, "player_id", 1, 16),
                     "checkpoint_sha256": _digest(checkpoint_sha256, "checkpoint_sha256"),
                     "catalog": catalog, "catalog_sha256": canonical_sha256(catalog),
                     "created_unix": time.time()}, "session_sha256")
    validate_session(record)
    atomic_json(spool_path(root, "session.json"), record)
    return record


def validate_session(record):
    expected = {"schema", "session_id", "player_id", "checkpoint_sha256", "catalog", "catalog_sha256",
                "created_unix", "session_sha256"}
    if set(record) != expected or record.get("schema") != SESSION_SCHEMA:
        raise SpoolError("Unsupported session envelope")
    _token(record["session_id"], "session_id")
    _integer(record["player_id"], "player_id", 1, 16)
    _digest(record["checkpoint_sha256"], "checkpoint_sha256")
    _timestamp(record["created_unix"], "created_unix")
    if not isinstance(record["catalog"], dict) or canonical_sha256(record["catalog"]) != record["catalog_sha256"]:
        raise SpoolError("Changed expected public catalog")
    verify_seal(record, "session_sha256")
    return record


def validate_catalog_compatibility(saved, live, registry, unit_types):
    """Check model vocabulary semantics, never replace its pinned type mapping."""
    for kind in ("units", "abilities"):
        if not isinstance(saved.get(kind), dict) or not isinstance(live.get(kind), dict):
            raise SpoolError("Public catalog lacks units or abilities")
    required_units = set(map(int, unit_types))
    for unit in required_units:
        previous, current = saved["units"].get(str(unit)), live["units"].get(str(unit))
        if (not previous or not current or previous.get("unit_id") != current.get("unit_id")
                or previous.get("name") != current.get("name")):
            raise SpoolError(f"Public unit vocabulary changed: {unit}")
    required_abilities = {row["ability_id"] for row in registry if row["ability_id"]}
    checked = []
    for ability in sorted(required_abilities):
        previous, current = saved["abilities"].get(str(ability)), live["abilities"].get(str(ability))
        if not previous:
            # Missing capabilities remain unavailable to prediction_to_intent.
            if current:
                raise SpoolError(f"Previously absent ability appeared: {ability}")
            continue
        fields = ("id", "target", "available", "allow_minimap", "remaps_to_ability_id")
        if not current or any(previous.get(key) != current.get(key) for key in fields):
            raise SpoolError(f"Public ability semantics changed: {ability}")
        checked.append(ability)
    return {"required_unit_ids_checked": len(required_units), "required_ability_ids_checked": len(checked),
            "saved_catalog_canonical_sha256": canonical_sha256(saved),
            "session_catalog_sha256": canonical_sha256(live), "compatible": True,
            "type_mapping_replaced": False}


def make_request(session, sequence, frame, timeout_seconds, *, now=None):
    now = time.time() if now is None else now
    if isinstance(timeout_seconds, bool) or not 0 < timeout_seconds <= MAX_TIMEOUT:
        raise SpoolError("Request timeout is outside bounded allowance")
    record = sealed({"schema": REQUEST_SCHEMA, "session_id": session["session_id"],
                     "session_sha256": session["session_sha256"], "sequence": sequence,
                     "player_id": session["player_id"], "game_loop": frame.get("game_loop"),
                     "frame": frame, "frame_sha256": canonical_sha256(frame),
                     "live_catalog_sha256": session["catalog_sha256"],
                     "created_unix": now, "deadline_unix": now + timeout_seconds}, "request_sha256")
    validate_request(record, session, sequence, now=now)
    return record


def validate_request(record, session, sequence, *, now=None, previous_loop=-1):
    now = time.time() if now is None else now
    keys = {"schema", "session_id", "session_sha256", "sequence", "player_id", "game_loop", "frame",
            "frame_sha256", "live_catalog_sha256", "created_unix", "deadline_unix", "request_sha256"}
    if set(record) != keys or record.get("schema") != REQUEST_SCHEMA:
        raise SpoolError("Request contains unsupported fields; observations only")
    if (record["session_id"] != session["session_id"] or record["session_sha256"] != session["session_sha256"]
            or record["player_id"] != session["player_id"] or record["sequence"] != sequence
            or record["live_catalog_sha256"] != session["catalog_sha256"]):
        raise SpoolError("Request session/player/sequence/catalog mismatch")
    _integer(record["sequence"], "sequence", 1, MAX_SEQUENCE)
    loop = _integer(record["game_loop"], "game_loop")
    if loop <= previous_loop:
        raise SpoolError("Observation loop did not advance")
    frame = record["frame"]
    if (not isinstance(frame, dict) or not set(frame) <= FRAME_KEYS or frame.get("game_loop") != loop
            or frame.get("hud", {}).get("player_id") != session["player_id"]
            or canonical_sha256(frame) != record["frame_sha256"]):
        raise SpoolError("Frame hash/player/schema mismatch or non-observation input")
    created, deadline = [_timestamp(record[key], key) for key in ("created_unix", "deadline_unix")]
    if (not 0 < deadline - created <= MAX_TIMEOUT or created > now + 5 or now > deadline
            or created < session["created_unix"]):
        raise SpoolError("Expired or invalid request deadline")
    verify_seal(record, "request_sha256")
    return record


def worker_identity(record):
    return tuple(record[key] for key in ("worker_id", "pid", "pid_creation_time", "session_sha256", "checkpoint_sha256"))


def validate_worker(record, session):
    if (record.get("schema") != WORKER_SCHEMA or record.get("session_id") != session["session_id"]
            or record.get("session_sha256") != session["session_sha256"]
            or record.get("checkpoint_sha256") != session["checkpoint_sha256"]
            or record.get("catalog_sha256") != session["catalog_sha256"]
            or record.get("optimizer_updates") != 0 or record.get("expert_labels_received") is not False):
        raise SpoolError("Worker handshake differs from prepared session")
    _token(record.get("worker_id"), "worker_id")
    _integer(record.get("pid"), "pid", 1)
    _timestamp(record.get("pid_creation_time"), "pid_creation_time")
    if canonical_sha256(record.get("registry")) != record.get("registry_sha256"):
        raise SpoolError("Worker registry hash mismatch")
    verify_seal(record, "worker_sha256")
    return record


def make_response(request, worker, record, intent, binding, *, now=None):
    response = {"schema": RESPONSE_SCHEMA, **{key: request[key] for key in
        ("session_id", "session_sha256", "sequence", "player_id", "game_loop", "frame_sha256", "request_sha256")},
        "worker_id": worker["worker_id"], "worker_sha256": worker["worker_sha256"],
        "checkpoint_sha256": worker["checkpoint_sha256"], "created_unix": time.time() if now is None else now,
        "record": record, "intent": intent, "binding": binding,
        "evidence": {"model_forward_executed": True, "optimizer_updates": 0, "expert_labels_used": False,
                     "checkpoint_optimizer_updates": worker["checkpoint_optimizer_updates"],
                     "warmup_source": "first_live_frame_paused_simulation", "frame_only_inference": True}}
    return sealed(response, "response_sha256")


def validate_response(response, request, worker, session, *, now=None):
    now = time.time() if now is None else now
    for key in ("session_id", "session_sha256", "sequence", "player_id", "game_loop", "frame_sha256", "request_sha256"):
        if response.get(key) != request[key]:
            raise SpoolError(f"Stale or mismatched response: {key}")
    if (response.get("schema") != RESPONSE_SCHEMA or response.get("worker_id") != worker["worker_id"]
            or response.get("worker_sha256") != worker["worker_sha256"]
            or response.get("checkpoint_sha256") != session["checkpoint_sha256"]
            or now > request["deadline_unix"] or response.get("created_unix", 0) < request["created_unix"]
            or response.get("created_unix", now + 10) > now + 5):
        raise SpoolError("Wrong worker/checkpoint or expired response")
    verify_seal(response, "response_sha256")
    evidence = response.get("evidence", {})
    if (evidence.get("model_forward_executed") is not True or evidence.get("optimizer_updates") != 0
            or evidence.get("expert_labels_used") is not False or evidence.get("frame_only_inference") is not True):
        raise SpoolError("Response lacks actual observation-only inference evidence")
    record, binding = response.get("record", {}), response.get("binding", {})
    if record.get("mask_checks_passed") is not True:
        raise SpoolError("Model selected a masked action")
    config = worker["tensor_config"]
    expected = bind_observation(request["frame"], binding.get("entity_tags"), worker["registry"], session["catalog"],
        session_id=session["session_id"], max_entities=config["max_entities"], max_selected=config["max_selected"])
    if binding != expected:
        raise SpoolError("Response observation binding changed")
    intent = prediction_to_intent(record["prediction"], worker["registry"], request["frame"], binding,
                                 session["catalog"], session_id=session["session_id"])
    if response.get("intent") != intent:
        raise SpoolError("Response intent does not equal actual prediction binding")
    return response


class FileSpoolClient:
    """One outstanding frame; SC2 caller must keep simulation paused in infer."""
    def __init__(self, session_dir, session_id, checkpoint_sha256, timeout_seconds=180, stop_check=None):
        self.directory = _root(session_dir)
        self.session = validate_session(read_json(spool_path(self.directory, "session.json")))
        if self.session["session_id"] != session_id or self.session["checkpoint_sha256"] != checkpoint_sha256:
            raise SpoolError("Client identity differs from prepared session")
        if isinstance(timeout_seconds, bool) or not 0 < timeout_seconds <= MAX_TIMEOUT:
            raise SpoolError("Client deadline out of bounds")
        self.timeout_seconds, self.stop_check = timeout_seconds, stop_check
        self.sequence, self.previous_loop, self.worker = 0, -1, None
        self._lock = asyncio.Lock()
        self.session_file_identity = file_identity(spool_path(self.directory, "session.json"))
        if next(self.directory.glob("receipt-*.json"), None) is not None:
            raise SpoolError("Consumed session cannot be reused by a new client")

    def _check(self):
        if spool_path(self.directory, "STOP").exists():
            raise SpoolError("STOP marker present")
        if self.stop_check is not None and self.stop_check():
            raise SpoolError("Host STOP requested")
        if file_identity(spool_path(self.directory, "session.json")) != self.session_file_identity:
            raise SpoolError("Prepared session changed")

    async def infer(self, frame):
        if self._lock.locked():
            raise SpoolError("Only one outstanding live inference request is allowed")
        async with self._lock:
            started = time.monotonic()
            while not spool_path(self.directory, "worker.json").exists():
                self._check()
                if time.monotonic() - started >= self.timeout_seconds:
                    raise SpoolError("Worker handshake deadline exceeded")
                await asyncio.sleep(.05)
            worker = validate_worker(read_json(spool_path(self.directory, "worker.json")), self.session)
            if self.worker is not None and worker_identity(worker) != worker_identity(self.worker):
                raise SpoolError("Worker identity changed inside active game")
            self.worker = worker
            request = make_request(self.session, self.sequence + 1, frame, self.timeout_seconds)
            validate_request(request, self.session, self.sequence + 1, previous_loop=self.previous_loop)
            self._check()
            atomic_json(numbered_path(self.directory, "request", request["sequence"]), request)
            response_path = numbered_path(self.directory, "response", request["sequence"])
            while True:
                self._check()
                current = validate_worker(read_json(spool_path(self.directory, "worker.json")), self.session)
                if current != worker:
                    raise SpoolError("Worker handshake changed during request")
                if response_path.exists():
                    response = validate_response(read_json(response_path, limit=MAX_RESPONSE_BYTES), request,
                                                 worker, self.session)
                    receipt = {key: response[key] for key in ("session_id", "sequence", "player_id", "game_loop",
                               "frame_sha256", "request_sha256", "response_sha256", "checkpoint_sha256", "worker_id")}
                    receipt.update(schema="alphastar-live-consumption-v1", consumed_unix=time.time())
                    atomic_json(spool_path(self.directory, f"receipt-{request['sequence']:06d}.json"), receipt,
                                limit=MAX_RESPONSE_BYTES)
                    # These exact paths were generated from our committed sequence;
                    # no caller-supplied deletion paths and no recursive cleanup.
                    numbered_path(self.directory, "request", request["sequence"]).unlink()
                    response_path.unlink()
                    self.sequence, self.previous_loop = request["sequence"], request["game_loop"]
                    return response
                status_path = spool_path(self.directory, "worker-status.json")
                status = await read_worker_status(status_path, deadline_unix=request["deadline_unix"],
                                                   stop_check=self._check)
                if status.get("worker_id") != worker["worker_id"] or status.get("status") in ("failed", "stopped", "complete"):
                    raise SpoolError(f"Worker unavailable: {status.get('status')}: {status.get('error', '')}")
                if time.time() > request["deadline_unix"]:
                    raise SpoolError("Live inference deadline exceeded; response must not execute")
                await asyncio.sleep(.05)
