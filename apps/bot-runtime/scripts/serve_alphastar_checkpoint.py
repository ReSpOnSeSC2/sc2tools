"""Persistent, bounded, file-spool inference for one restricted SC2 session.

Uses the frozen CheckpointPolicy and observation encoder. It never reads replay
labels, starts a game, creates an optimizer, or issues a native SC2 action.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import time
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from scripts.infer_alphastar_checkpoint import CheckpointPolicy, read_checkpoint_artifacts  # noqa: E402
from scripts.preflight_alphastar_curriculum import host_path  # noqa: E402
from scripts.train_alphastar_replay import DEFAULT_UPSTREAM, sha256, verify_upstream  # noqa: E402
from pluto_sc2.alphastar_tensor import tensorize_observation  # noqa: E402
from pluto_sc2.policy_intents import bind_observation, canonical_sha256, prediction_to_intent  # noqa: E402
from pluto_sc2.alphastar_spool import (  # noqa: E402
    FRAME_KEYS, MAX_RESPONSE_BYTES, WORKER_SCHEMA, SpoolError, atomic_json, file_identity, make_response,
    numbered_path, read_json, sealed, spool_path, validate_catalog_compatibility, validate_request,
    validate_session,
)


def permitted_example(frame, artifacts, session):
    if not isinstance(frame, dict) or not set(frame) <= FRAME_KEYS:
        raise SpoolError("Warmup/live input must contain only permitted observation fields")
    encoded = tensorize_observation(frame, artifacts["registry"], artifacts["unit_types"], artifacts["config"])
    binding = bind_observation(frame, encoded["metadata"]["entity_tags"], artifacts["registry"], session["catalog"],
                               session_id=session["session_id"], max_entities=artifacts["config"].max_entities,
                               max_selected=artifacts["config"].max_selected)
    return encoded, binding


def validate_host_finished(record, session):
    if (record.get("session_id") != session["session_id"]
            or record.get("checkpoint_sha256") != session["checkpoint_sha256"]
            or not isinstance(record.get("status"), str)
            or not isinstance(record.get("finished_unix"), (int, float))
            or not session["created_unix"] <= record["finished_unix"] <= time.time() + 5):
        raise SpoolError("Host completion marker differs from this session")
    return record


def serve(args):
    if not 1 <= args.max_requests <= 4096 or not 1 <= args.max_seconds <= 7200:
        raise SpoolError("Worker bounds exceed4096 requests or7200 seconds")
    if bool(args.warmup_frame) != bool(args.warmup_sha256):
        raise SpoolError("Warmup requires both frame-only path and exact file hash")
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    sys.dont_write_bytecode = True
    directory = Path(args.session).resolve()
    origin, catalog_path = Path(args.run).resolve(), Path(args.catalog).resolve()
    started, worker_id = time.monotonic(), uuid.uuid4().hex
    session = validate_session(read_json(spool_path(directory, "session.json")))
    session_file_identity = file_identity(spool_path(directory, "session.json"))
    import psutil
    pid_creation_time = psutil.Process(os.getpid()).create_time()
    atomic_json(spool_path(directory, "worker-lock.json"), {
        "session_id": session["session_id"], "worker_id": worker_id, "pid": os.getpid(),
        "pid_creation_time": pid_creation_time, "created_unix": time.time()})
    status = {"schema": "alphastar-live-worker-status-v1", "session_id": session["session_id"],
              "worker_id": worker_id, "pid": os.getpid(), "pid_creation_time": pid_creation_time,
              "status": "initializing", "started_unix": time.time(), "last_sequence": 0,
              "last_game_loop": -1, "optimizer_updates": 0, "expert_labels_received": False,
              "model_predictions": 0, "warmup_complete": False, "max_requests": args.max_requests,
              "max_seconds": args.max_seconds}
    pins = {}
    policy = None
    stop_paths = [spool_path(directory, "STOP"), origin / "STOP", *map(Path, args.stop)]

    def save_status():
        status["updated_unix"] = time.time()
        atomic_json(spool_path(directory, "worker-status.json"), status, replace=True, limit=MAX_RESPONSE_BYTES)

    def check():
        if any(path.exists() for path in stop_paths):
            raise SpoolError("STOP marker present; no response may execute")
        if time.monotonic() - started > args.max_seconds:
            raise SpoolError("Bounded inference worker wall deadline exceeded")
        if file_identity(spool_path(directory, "session.json")) != session_file_identity:
            raise SpoolError("Prepared session changed during worker lifetime")

    def unchanged():
        if any(sha256(path) != digest for path, digest in pins.items()):
            raise SpoolError("Pinned model/catalog/source changed during live inference")

    def initialize(example):
        check()
        result = CheckpointPolicy(artifacts, example, upstream=args.upstream, seed=args.seed,
                                  sampling_mode=args.sampling_mode)
        if not any(device.platform == "gpu" for device in result.jax.devices()):
            raise SpoolError("Live worker requires the pinned GPU runtime")
        if result.jax.tree_util.tree_leaves(result.state):
            raise SpoolError("This live host supports only the reviewed stateless checkpoint")
        check()
        unchanged()
        return result

    save_status()
    try:
        check()
        artifacts = read_checkpoint_artifacts(origin, catalog_path)
        if artifacts["checkpoint_sha256"] != session["checkpoint_sha256"]:
            raise SpoolError("Worker checkpoint differs from prepared host")
        compatibility = validate_catalog_compatibility(artifacts["catalog"], session["catalog"],
                                                        artifacts["registry"], artifacts["unit_types"])
        verify_upstream(args.upstream)
        for path, digest in artifacts["result"]["source_hashes"].items():
            current = host_path(path).resolve()
            if sha256(current) != digest:
                raise SpoolError(f"Current model source differs from frozen checkpoint: {current.name}")
            pins[str(current)] = digest
        for name, digest in (("checkpoint.msgpack", artifacts["checkpoint_sha256"]),
                             ("result.json", artifacts["result_sha256"]), ("registry.json", artifacts["registry_sha256"])):
            pins[str(origin / name)] = digest
        pins[str(catalog_path)] = artifacts["result"]["dataset_hashes"]["game_data"]
        for path in (Path(__file__), ROOT / "src/pluto_sc2/alphastar_spool.py", ROOT / "src/pluto_sc2/policy_intents.py"):
            pins[str(path.resolve())] = sha256(path)
        unchanged()
        status.update(checkpoint_sha256=artifacts["checkpoint_sha256"], checkpoint_optimizer_updates=artifacts["result"]["optimizer_updates"],
                      source_hashes=pins, catalog_compatibility=compatibility)
        if args.warmup_frame:
            warmup_path = Path(args.warmup_frame).resolve()
            if sha256(warmup_path) != args.warmup_sha256:
                raise SpoolError("Warmup observation hash mismatch")
            frame = read_json(warmup_path)
            example, _ = permitted_example(frame, artifacts, session)
            pins[str(warmup_path)] = args.warmup_sha256
            policy = initialize(example)
            warm = policy.predict(example)
            if not warm["mask_checks_passed"]:
                raise SpoolError("Warmup prediction mask validation failed")
            if policy.jax.tree_util.tree_leaves(policy.state):
                raise SpoolError("Warmup unexpectedly changed temporal state")
            policy.key = policy.jax.random.PRNGKey(args.seed)
            del warm, frame, example
            check()
            unchanged()
            status.update(warmup_complete=True, warmup_frame_sha256=args.warmup_sha256,
                          warmup_source="permitted_saved_observation_only", warmup_prediction_discarded=True,
                          rng_reset_after_warmup=True)
        worker = sealed({"schema": WORKER_SCHEMA, "session_id": session["session_id"],
            "session_sha256": session["session_sha256"], "worker_id": worker_id, "pid": os.getpid(),
            "pid_creation_time": pid_creation_time, "checkpoint_sha256": artifacts["checkpoint_sha256"],
            "checkpoint_optimizer_updates": artifacts["result"]["optimizer_updates"],
            "registry": artifacts["registry"], "registry_sha256": canonical_sha256(artifacts["registry"]),
            "catalog_sha256": session["catalog_sha256"], "catalog_compatibility": compatibility,
            "tensor_config": artifacts["result"]["tensor_config"], "optimizer_updates": 0,
            "expert_labels_received": False, "sampling_mode": args.sampling_mode, "seed": args.seed,
            "capacity_adapter": artifacts["result"].get("capacity_adapter"),
            "matmul_precision": artifacts["result"].get("matmul_precision"),
            "warmup_complete": status["warmup_complete"], "source_hashes": pins,
            "warmup_source": status.get("warmup_source", "first_live_frame_paused_simulation")}, "worker_sha256")
        atomic_json(spool_path(directory, "worker.json"), worker)
        status["status"] = "ready" if policy is not None else "waiting_frame"
        save_status()
        last_status = time.monotonic()
        for sequence in range(1, args.max_requests + 1):
            request_path = numbered_path(directory, "request", sequence)
            while not request_path.exists():
                check()
                finished = spool_path(directory, "host-finished.json")
                if finished.exists():
                    status.update(status="complete", host_finished=validate_host_finished(read_json(finished), session))
                    return
                if time.monotonic() - last_status >= 2:
                    save_status()
                    last_status = time.monotonic()
                time.sleep(.05)
            check()
            request = validate_request(read_json(request_path), session, sequence, previous_loop=status["last_game_loop"])
            example, binding = permitted_example(request["frame"], artifacts, session)
            if binding["frame_sha256"] != request["frame_sha256"] or binding["player_id"] != request["player_id"]:
                raise SpoolError("Encoder binding does not match exact requested frame")
            status.update(status="processing", processing_sequence=sequence)
            save_status()
            if policy is None:
                policy = initialize(example)
            record = policy.predict(example)
            check()
            validate_request(request, session, sequence, previous_loop=status["last_game_loop"])
            if not record["mask_checks_passed"]:
                raise SpoolError("Actual model forward selected a masked action")
            if sequence == 1 or sequence % 32 == 0:
                unchanged()
            intent = prediction_to_intent(record["prediction"], artifacts["registry"], request["frame"], binding,
                                          session["catalog"], session_id=session["session_id"])
            response = make_response(request, worker, record, intent, binding)
            response["evidence"]["warmup_source"] = worker["warmup_source"]
            response.pop("response_sha256")
            response = sealed(response, "response_sha256")
            atomic_json(numbered_path(directory, "response", sequence), response, limit=MAX_RESPONSE_BYTES)
            status.update(status="ready", last_sequence=sequence, last_game_loop=request["game_loop"],
                          model_predictions=sequence, warmup_complete=True, last_intent_admitted=intent["admitted"])
            status.pop("processing_sequence", None)
            save_status()
        status.update(status="complete", stop_reason="bounded_request_count_reached")
    except BaseException as exc:
        status.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        try:
            unchanged()
            status["source_inputs_checkpoint_unchanged"] = True
        except BaseException as exc:
            status.update(status="failed", source_inputs_checkpoint_unchanged=False,
                          finalization_error=f"{type(exc).__name__}: {exc}")
        status.update(finished_unix=time.time(), wall_seconds=time.monotonic() - started)
        save_status()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--warmup-frame", type=Path)
    parser.add_argument("--warmup-sha256")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--sampling-mode", choices=("greedy", "sample"), default="greedy")
    parser.add_argument("--max-requests", type=int, default=4096)
    parser.add_argument("--max-seconds", type=int, default=3600)
    parser.add_argument("--stop", type=Path, action="append", default=[])
    serve(parser.parse_args())


if __name__ == "__main__":
    main()
