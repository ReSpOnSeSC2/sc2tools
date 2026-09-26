"""Strict local live-model transport; all model replies below are test fixtures."""
import asyncio
from copy import deepcopy
import errno
import json
import time

import pytest

from pluto_sc2.alphastar_spool import (
    FileSpoolClient, SpoolError, WORKER_SCHEMA, atomic_json, create_session, make_request,
    make_response, numbered_path, read_json, sealed, spool_path, validate_catalog_compatibility,
    validate_request, validate_response, validate_session, validate_worker,
    read_worker_status,
)
from pluto_sc2.policy_intents import bind_observation, canonical_sha256, prediction_to_intent
from test_policy_intents import REGISTRY, SESSION, catalog, frame, prediction, tags


@pytest.fixture
def packet(tmp_path):
    public = catalog()
    session = create_session(tmp_path, SESSION, "a" * 64, public, player_id=2)
    value = frame()
    request = make_request(session, 1, value, 180)
    worker = sealed({"schema": WORKER_SCHEMA, "session_id": SESSION, "session_sha256": session["session_sha256"],
        "worker_id": "test-worker-unique-id", "pid": 123, "pid_creation_time": time.time(),
        "checkpoint_sha256": "a" * 64, "checkpoint_optimizer_updates": 5065,
        "catalog_sha256": session["catalog_sha256"], "registry": REGISTRY,
        "registry_sha256": canonical_sha256(REGISTRY), "optimizer_updates": 0, "expert_labels_received": False,
        "tensor_config": {"max_entities": 8, "max_selected": 4}}, "worker_sha256")
    heads = {key: val.tolist() if hasattr(val, "tolist") else val for key, val in prediction(value=value).items()}
    # Delay/repeat remain ignored disabled heads at intent boundary.
    record = {"prediction": heads, "mask_checks_passed": True, "function": "Build_Pylon_pt"}
    binding = bind_observation(value, tags(value), REGISTRY, public, session_id=SESSION, max_entities=8, max_selected=4)
    intent = prediction_to_intent(heads, REGISTRY, value, binding, public, session_id=SESSION)
    response = make_response(request, worker, record, intent, binding)
    return tmp_path, session, request, worker, response


def test_valid_packet_recomputes_exact_live_binding_and_intent(packet):
    _, session, request, worker, response = packet
    assert validate_session(session) == session
    assert validate_worker(worker, session) == worker
    assert validate_request(request, session, 1) == request
    assert validate_response(response, request, worker, session) == response
    assert response["intent"]["admitted"] and response["intent"]["provenance"] == "policy_prediction"


@pytest.mark.parametrize("field,value", [("sequence", 2), ("player_id", 1), ("session_id", "other-session-identity"),
    ("frame_sha256", "b" * 64), ("session_sha256", "b" * 64), ("request_sha256", "b" * 64)])
def test_foreign_or_stale_response_is_rejected_even_if_other_data_valid(packet, field, value):
    _, session, request, worker, response = packet
    response[field] = value
    with pytest.raises(SpoolError):
        validate_response(response, request, worker, session)


@pytest.mark.parametrize("field,value", [("worker_id", "different-worker-id"), ("worker_sha256", "b" * 64),
    ("checkpoint_sha256", "b" * 64)])
def test_worker_and_model_cannot_change_mid_game(packet, field, value):
    _, session, request, worker, response = packet
    response[field] = value
    with pytest.raises(SpoolError):
        validate_response(response, request, worker, session)


def test_resealed_intent_or_binding_tamper_still_fails_semantic_validation(packet):
    _, session, request, worker, response = packet
    for which in ("intent", "binding"):
        modified = deepcopy(response)
        modified[which]["unexpected"] = True
        modified.pop("response_sha256")
        modified = sealed(modified, "response_sha256")
        with pytest.raises(SpoolError):
            validate_response(modified, request, worker, session)


def test_masked_or_non_forward_reply_cannot_execute(packet):
    _, session, request, worker, response = packet
    for kind in ("mask", "optimizer", "label", "forward"):
        modified = deepcopy(response)
        if kind == "mask":
            modified["record"]["mask_checks_passed"] = False
        else:
            field, value = {"optimizer": ("optimizer_updates", 1), "label": ("expert_labels_used", True),
                            "forward": ("model_forward_executed", False)}[kind]
            modified["evidence"][field] = value
        modified.pop("response_sha256")
        with pytest.raises(SpoolError):
            validate_response(sealed(modified, "response_sha256"), request, worker, session)


def test_deadlines_and_strict_increasing_loop_reject_old_decisions(packet):
    _, session, request, worker, response = packet
    with pytest.raises(SpoolError, match="deadline"):
        validate_request(request, session, 1, now=request["deadline_unix"] + .1)
    with pytest.raises(SpoolError, match="expired"):
        validate_response(response, request, worker, session, now=request["deadline_unix"] + .1)
    with pytest.raises(SpoolError, match="did not advance"):
        validate_request(request, session, 1, previous_loop=request["game_loop"])


def test_expert_fields_or_changed_live_frame_are_rejected(packet):
    _, session, request, _, _ = packet
    for field in ("intent", "labels", "behavior_features", "expert_action"):
        modified = deepcopy(request)
        modified[field] = {"function": 4}
        with pytest.raises(SpoolError, match="observations only"):
            validate_request(modified, session, 1)
        value = deepcopy(request["frame"])
        value[field] = {"function": 4}
        with pytest.raises(SpoolError, match="non-observation"):
            make_request(session, 1, value, 180)
    request["frame"]["hud"]["minerals"] += 1
    with pytest.raises(SpoolError, match="Frame hash"):
        validate_request(request, session, 1)


@pytest.mark.parametrize("name", ["../outside.json", "C:/outside.json", "/outside", "..", "request\\other"])
def test_spool_paths_cannot_escape_session(tmp_path, name):
    with pytest.raises(SpoolError):
        spool_path(tmp_path, name)


def test_atomic_files_are_immutable_and_bounded(tmp_path):
    path = tmp_path / "request-000001.json"
    atomic_json(path, {"frame": 1})
    with pytest.raises(FileExistsError):
        atomic_json(path, {"frame": 2})
    assert read_json(path) == {"frame": 1}
    assert not list(tmp_path.glob("*.pending"))
    with pytest.raises(SpoolError, match="byte limit"):
        atomic_json(tmp_path / "too-big.json", {"a": "x" * 50}, limit=20)
    with pytest.raises(SpoolError):
        read_json(path, limit=1)
    path.write_text('{"a":1,"a":2}')
    with pytest.raises(SpoolError, match="Duplicate"):
        read_json(path)
    path.write_text('{"a":NaN}')
    with pytest.raises(SpoolError, match="Nonfinite"):
        read_json(path)


def test_required_native_catalog_types_and_ability_semantics_must_match():
    saved = {"units": {"84": {"unit_id": 84, "name": "Probe"}},
             "abilities": {"881": {"id": 881, "target": 2, "available": True}}}
    registry = [{"ability_id": 881}]
    assert validate_catalog_compatibility(saved, deepcopy(saved), registry, {84: 1})["compatible"]
    changed = deepcopy(saved)
    changed["units"]["84"]["name"] = "Stalker"
    with pytest.raises(SpoolError, match="unit vocabulary"):
        validate_catalog_compatibility(saved, changed, registry, {84: 1})
    changed = deepcopy(saved)
    changed["abilities"]["881"]["target"] = 3
    with pytest.raises(SpoolError, match="ability semantics"):
        validate_catalog_compatibility(saved, changed, registry, {84: 1})


def test_client_accepts_single_bound_reply_retains_receipt_and_cleans_owned_frames(packet):
    directory, session, _, worker, prototype = packet
    atomic_json(directory / "worker.json", worker)
    atomic_json(directory / "worker-status.json", {"worker_id": worker["worker_id"], "status": "ready"})

    async def scenario():
        client = FileSpoolClient(directory, SESSION, "a" * 64, timeout_seconds=2)

        async def fixture_worker():
            path = numbered_path(directory, "request", 1)
            while not path.exists():
                await asyncio.sleep(.01)
            request = read_json(path)
            response = make_response(request, worker, prototype["record"], prototype["intent"], prototype["binding"])
            atomic_json(numbered_path(directory, "response", 1), response)

        task = asyncio.create_task(fixture_worker())
        response = await client.infer(frame())
        await task
        assert response["sequence"] == 1 and client.sequence == 1
        assert not numbered_path(directory, "request", 1).exists()
        assert not numbered_path(directory, "response", 1).exists()
        receipt = read_json(directory / "receipt-000001.json")
        assert receipt["response_sha256"] == response["response_sha256"] and "frame" not in receipt
        assert receipt["frame_sha256"] == canonical_sha256(frame())
        with pytest.raises(SpoolError, match="did not advance"):
            await client.infer(frame())

    asyncio.run(scenario())
    with pytest.raises(SpoolError, match="cannot be reused"):
        FileSpoolClient(directory, session["session_id"], "a" * 64)


def test_stop_marker_blocks_before_request_publication(packet):
    directory, _, _, worker, _ = packet
    atomic_json(directory / "worker.json", worker)
    (directory / "STOP").write_text("user stop")
    client = FileSpoolClient(directory, SESSION, "a" * 64, timeout_seconds=.1)
    with pytest.raises(SpoolError, match="STOP"):
        asyncio.run(client.infer(frame()))
    assert not list(directory.glob("request-*.json"))


def test_server_preprocessing_rejects_labels_without_loading_model_or_game(packet):
    from scripts.serve_alphastar_checkpoint import permitted_example, validate_host_finished
    _, session, request, _, _ = packet
    with pytest.raises(SpoolError, match="only permitted observation"):
        permitted_example({**request["frame"], "intent": {"ability_id": 23}}, {}, session)
    with pytest.raises(SpoolError, match="differs"):
        validate_host_finished({"session_id": "other", "checkpoint_sha256": "a" * 64,
                                "status": "complete", "finished_unix": time.time()}, session)
    marker = {"session_id": SESSION, "checkpoint_sha256": "a" * 64, "status": "complete", "finished_unix": time.time()}
    assert validate_host_finished(marker, session) == marker


def test_saved_session_file_change_blocks_active_client(packet):
    directory, session, _, worker, _ = packet
    client = FileSpoolClient(directory, SESSION, "a" * 64, timeout_seconds=.1)
    atomic_json(directory / "worker.json", worker)
    changed = deepcopy(session)
    changed["player_id"] = 1
    (directory / "session.json").write_text(json.dumps(changed))
    with pytest.raises(SpoolError, match="session changed"):
        asyncio.run(client.infer(frame()))


def test_one_off_status_sharing_violation_retries_then_validates_json(monkeypatch, tmp_path):
    import pluto_sc2.alphastar_spool as spool
    path = tmp_path / "worker-status.json"
    atomic_json(path, {"worker_id": "fixture", "status": "ready"})
    original = spool.read_json
    calls, checks = [], []

    def intermittent(path, **kwargs):
        calls.append(path)
        if len(calls) == 1:
            raise PermissionError(errno.EACCES, "File sharing conflict")
        return original(path, **kwargs)

    monkeypatch.setattr(spool, "read_json", intermittent)
    result = asyncio.run(read_worker_status(path, deadline_unix=time.time() + 1,
                                            stop_check=lambda: checks.append(True), retry_delay=0))
    assert result == {"worker_id": "fixture", "status": "ready"}
    assert len(calls) == 2 and len(checks) == 3


def test_persistent_status_denial_is_bounded_and_original_error_propagates(monkeypatch, tmp_path):
    import pluto_sc2.alphastar_spool as spool
    attempts = []

    def denied(*args, **kwargs):
        attempts.append(True)
        raise PermissionError(errno.EACCES, "Permanent access denial")

    monkeypatch.setattr(spool, "read_json", denied)
    with pytest.raises(PermissionError, match="Permanent access denial"):
        asyncio.run(read_worker_status(tmp_path / "worker-status.json", deadline_unix=time.time() + 2,
                                       stop_check=lambda: None, retry_delay=0))
    assert len(attempts) == 8


@pytest.mark.parametrize("error", [FileNotFoundError("gone"), OSError(errno.EIO, "disk"),
                                      PermissionError(errno.EPERM, "not a sharing denial"), SpoolError("Malformed JSON")])
def test_other_status_errors_are_not_retried(monkeypatch, tmp_path, error):
    import pluto_sc2.alphastar_spool as spool
    attempts = []

    def failed(*args, **kwargs):
        attempts.append(True)
        raise error

    monkeypatch.setattr(spool, "read_json", failed)
    with pytest.raises(type(error)):
        asyncio.run(read_worker_status(tmp_path / "worker-status.json", deadline_unix=time.time() + 1,
                                       stop_check=lambda: None, retry_delay=0))
    assert len(attempts) == 1


def test_status_retry_never_extends_absolute_request_deadline(monkeypatch, tmp_path):
    import pluto_sc2.alphastar_spool as spool
    now, attempts = [100.0], []
    monkeypatch.setattr(spool.time, "time", lambda: now[0])

    def delayed_denial(*args, **kwargs):
        attempts.append(True)
        now[0] = 102.0
        raise PermissionError(errno.EACCES, "File sharing conflict")

    monkeypatch.setattr(spool, "read_json", delayed_denial)
    with pytest.raises(SpoolError, match="deadline exceeded"):
        asyncio.run(read_worker_status(tmp_path / "worker-status.json", deadline_unix=101.0,
                                       stop_check=lambda: None, retry_delay=0))
    assert len(attempts) == 1


def test_stop_arriving_between_status_retries_prevents_next_read(monkeypatch, tmp_path):
    import pluto_sc2.alphastar_spool as spool
    attempts = []

    def denied(*args, **kwargs):
        attempts.append(True)
        raise PermissionError(errno.EACCES, "File sharing conflict")

    def stop_check():
        if attempts:
            raise SpoolError("STOP arrived")

    monkeypatch.setattr(spool, "read_json", denied)
    with pytest.raises(SpoolError, match="STOP arrived"):
        asyncio.run(read_worker_status(tmp_path / "worker-status.json", deadline_unix=time.time() + 1,
                                       stop_check=stop_check, retry_delay=0))
    assert len(attempts) == 1


def test_real_malformed_status_json_is_never_retried(monkeypatch, tmp_path):
    import pluto_sc2.alphastar_spool as spool
    path = tmp_path / "worker-status.json"
    path.write_text('{"partial":')
    original, attempts = spool.read_json, []

    def counted(*args, **kwargs):
        attempts.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(spool, "read_json", counted)
    with pytest.raises(SpoolError, match="Invalid JSON"):
        asyncio.run(read_worker_status(path, deadline_unix=time.time() + 1,
                                       stop_check=lambda: None, retry_delay=0))
    assert len(attempts) == 1
