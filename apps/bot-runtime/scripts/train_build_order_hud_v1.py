"""Own-HUD residual fitting; immutable P3492 and separately aged adapter Adam.

First run is bounded. Continuous continuation requires an explicit reviewed
receipt, retains the exact cursor/optimizer, and never promotes a live actor.
"""
from __future__ import annotations

import argparse
from collections import Counter
import copy
from datetime import datetime, timezone
import io
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import numpy as np  # noqa: E402
import psutil  # noqa: E402
import torch  # noqa: E402
from scripts import train_build_order_prior_v2 as prior  # noqa: E402
from pluto_sc2.build_order_hud_prior_v1 import HudResidualPrior, SCHEMA, verify_frozen_base  # noqa: E402

PARENT_SHA = "717f437beb02d7fc99fa2e70d514d4a781582399cadf7c456393ac3f4910cef5"
SEQUENCE_SHA = "8cb5ac66b182e71cc2000b13503198d939be5f15e9b2904977cbee9e44685034"
BASELINE_SHA = "2535e288a6db85dfb9d9c8de71945d17301fa48e18ad1e7b3684ab9210bead56"
HUD_REVIEW_SHA = "50371a555fe7ec7c56cd3b58112b9dac5ab2f2a3abebd6ad429d2f70f7597596"
CONTRACT = "causal-own-hud-residual-frozen-base-v1"
LR = .0005
DEEP = frozenset(("first_nexus", "first_gas", "first_core", "first_probe_after_core",
                  "first_stalker", "first_tech_structure", "first_research"))


def exact(a, b):
    if isinstance(a, torch.Tensor):
        return (isinstance(b, torch.Tensor) and a.dtype == b.dtype and a.shape == b.shape
                and a.detach().cpu().contiguous().numpy().tobytes() == b.detach().cpu().contiguous().numpy().tobytes())
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(exact(v, b[k]) for k, v in a.items())
    if isinstance(a, (tuple, list)):
        return type(a) is type(b) and len(a) == len(b) and all(exact(x, y) for x, y in zip(a, b))
    return a == b


def tensor_tree_sha(value):
    digest = hashlib.sha256()
    def visit(node):
        if isinstance(node, torch.Tensor):
            digest.update(str((str(node.dtype), tuple(node.shape))).encode())
            digest.update(node.detach().cpu().contiguous().numpy().tobytes())
        elif isinstance(node, dict):
            for key in sorted(node, key=str):
                digest.update(repr(key).encode())
                visit(node[key])
        elif isinstance(node, (list, tuple)):
            digest.update(type(node).__name__.encode())
            for item in node:
                visit(item)
        else:
            digest.update(repr(node).encode())
    visit(value)
    return digest.hexdigest()


def allocate_snapshot(output, serial, updates):
    serial += 1
    while (Path(output) / f"checkpoint-{serial:06d}-adapter{updates:08d}.pt").exists():
        serial += 1
    return serial, f"checkpoint-{serial:06d}-adapter{updates:08d}.pt"


def append_epoch_receipt(output, record, previous):
    content = {"schema": "own-hud-epoch-metrics-v1", "previous_receipt_sha256": previous, **record}
    data = (json.dumps(content, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
    path = Path(output) / f"epoch-{record['epoch']:06d}-metrics.json"
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("Orphan epoch receipt disagrees with exact resumed evaluation")
    else:
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return prior.bytes_sha(data)


def verify_epoch_chain(output, epochs, wanted):
    previous = None
    for epoch in range(1, epochs + 1):
        raw = (Path(output) / f"epoch-{epoch:06d}-metrics.json").read_bytes()
        value = json.loads(raw)
        if (value.get("schema") != "own-hud-epoch-metrics-v1" or value.get("epoch") != epoch
                or value.get("previous_receipt_sha256") != previous or value.get("adapter_updates") != epoch * 378):
            raise ValueError("Immutable epoch metric chain changed")
        previous = prior.bytes_sha(raw)
    if previous != wanted:
        raise ValueError("Checkpoint epoch chain hash differs")


class TrainingLease:
    """OS-owned byte lock survives metadata races and releases on process death."""
    def __init__(self, path):
        self.path = Path(path)
        self.stream = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        self.stream.seek(0, 2)
        if self.stream.tell() == 0:
            self.stream.write(b"0")
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            self.stream = None
            raise RuntimeError("Another HUD trainer holds the exclusive lease") from exc
        self.identity = {"pid": os.getpid(), "pid_creation_time": psutil.Process().create_time()}
        prior.write_json(self.path.with_suffix(".json"), {**self.identity, "acquired_at": now(), "active": True})
        return self

    def __exit__(self, *unused):
        if self.stream is not None:
            prior.write_json(self.path.with_suffix(".json"), {**self.identity, "released_at": now(), "active": False})
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_UN)
            self.stream.close()


def now():
    return datetime.now(timezone.utc).isoformat()


def feature_key(row, index):
    return row["replay_id"], row["player_id"], row["commands"][index]["source_event_index"]


def batch(examples, vocabulary, features):
    values = prior.collate_examples([prior.prefix_example(r, i, vocabulary) for r, i in examples])
    hud = torch.tensor(np.stack([features[feature_key(r, i)] for r, i in examples]), dtype=torch.float32)
    return *values, hud


def verify_adapter_optimizer(model, optimizer, updates):
    if len(optimizer.param_groups) != 1 or [id(p) for p in optimizer.param_groups[0]["params"]] != [id(model.adapter.weight)]:
        raise ValueError("Optimizer includes parameters outside the residual adapter")
    group = optimizer.param_groups[0]
    if (group["lr"] != LR or group["betas"] != (.9, .999) or group["eps"] != 1e-8
            or group["weight_decay"] != 0 or group["amsgrad"] or group["maximize"]):
        raise ValueError("Adapter optimizer contract changed")
    parameter = model.adapter.weight
    if not torch.isfinite(parameter).all():
        raise ValueError("Nonfinite adapter parameters")
    state = optimizer.state.get(parameter, {})
    if updates == 0 and not state:
        return
    if (set(state) != {"step", "exp_avg", "exp_avg_sq"} or float(state["step"]) != updates
            or any(state[k].shape != parameter.shape or not torch.isfinite(state[k]).all()
                   for k in ("exp_avg", "exp_avg_sq"))):
        raise ValueError("Adapter Adam count or moments changed")


def next_order(examples, generator):
    order = list(range(len(examples)))
    generator.shuffle(order)
    return order


def weighted_training_examples(records):
    result = []
    for row in records:
        if row["race"] != "Protoss" or row["partition"] != "train":
            continue
        if type(row["weight"]) not in (int, float) or row["weight"] not in (1, 2):
            raise ValueError("Only already admitted whole-perspective weights1/2 are supported")
        result.extend((row, i) for _ in range(int(row["weight"])) for i, command in enumerate(row["commands"])
                      if command["game_loop"] <= 480 * 22.4)
    return result


def validate_cursor(cursor, example_count, updates=None):
    if (type(cursor.get("epochs_completed")) is not int or cursor["epochs_completed"] < 0
            or cursor.get("phase") not in ("ready", "training", "evaluation")
            or type(cursor.get("next_offset")) is not int):
        raise ValueError("Malformed durable training cursor")
    order = cursor["order"]
    if cursor["phase"] == "ready":
        if order or cursor["next_offset"] != 0:
            raise ValueError("Ready cursor contains a partial pass")
    elif (sorted(order) != list(range(example_count)) or any(type(i) is not int for i in order)
          or not 0 <= cursor["next_offset"] <= example_count
          or cursor["next_offset"] % 128 != 0 and cursor["next_offset"] != example_count
          or cursor["phase"] == "evaluation" and cursor["next_offset"] != example_count):
        raise ValueError("Partial cursor does not cover the exact weighted pass")
    if updates is not None and (type(updates) is not int or updates != cursor["epochs_completed"] * math.ceil(example_count / 128)
                                + math.ceil(cursor["next_offset"] / 128)):
        raise ValueError("Adapter age and accepted-example cursor disagree")


def step(model, optimizer, values, before_step=None):
    tokens, times, lengths, target, _, hud = values
    if bool((target < 2).any()):
        raise ValueError("Unknown TRAIN label")
    logits, _ = model(tokens, times, lengths, model.vocabulary_size, hud)
    loss = torch.nn.functional.cross_entropy(logits, target)  # No class/outcome loss tilt.
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    norm = torch.nn.utils.clip_grad_norm_(model.adapter.parameters(), 5.)
    if not bool(torch.isfinite(loss)) or not bool(torch.isfinite(norm)):
        raise ValueError("Nonfinite adapter loss or gradient")
    if before_step is not None:
        before_step()
    optimizer.step()
    return float(loss.detach())


def evaluate(model, examples, vocabulary, features, categories, milestone_ids, check, *, parity=False):
    model.eval()
    totals = Counter(events=0, correct=0, top3=0)
    ce, wait_error = 0., 0.
    by_category, by_matchup, milestones = {}, {}, {}
    first_opening, seen = Counter(), set()
    with torch.inference_mode():
        for offset in range(0, len(examples), 256):
            check()
            chunk = examples[offset:offset + 256]
            tokens, times, lengths, targets, wanted_wait, hud = batch(chunk, vocabulary, features)
            logits, wait = model(tokens, times, lengths, len(vocabulary), hud)
            if parity:
                expected = model.base(tokens, times, lengths, len(vocabulary))
                if not torch.equal(logits, expected[0]) or not torch.equal(wait, expected[1]):
                    raise ValueError("Initial complete logits/wait parity failed")
            if not torch.isfinite(logits).all() or not torch.isfinite(wait).all() or bool((targets < 2).any()):
                raise ValueError("Nonfinite prediction or unsupported validation target")
            predictions = logits.argmax(-1)
            ce += float(torch.nn.functional.cross_entropy(logits, targets, reduction="sum"))
            wait_error += float((torch.expm1(wait.clamp(max=15)) - torch.expm1(wanted_wait)).abs().sum())
            tops = logits.topk(3, dim=-1).indices
            for j, (row, index) in enumerate(chunk):
                correct = int(predictions[j] == targets[j])
                totals.update(events=1, correct=correct, top3=int((tops[j] == targets[j]).any()))
                category, name = categories[prior.token_key(row["commands"][index])]
                for key, groups in ((category, by_category), (row["matchup"], by_matchup)):
                    groups.setdefault(key, Counter()).update(events=1, correct=correct)
                opening_id = row["replay_id"], row["player_id"], name
                if name in ("BuildPylon", "BuildGateway") and opening_id not in seen:
                    seen.add(opening_id)
                    first_opening[name] += correct
                for milestone in milestone_ids.get(feature_key(row, index), []):
                    milestones.setdefault(milestone, Counter()).update(events=1, correct=correct)
    deep_count = sum(v["events"] for v in milestones.values())
    if deep_count != 970:
        raise ValueError("Seven-milestone validation cohort changed")
    worker, army = by_category["worker"], by_category["army_production"]
    if worker["events"] != 5108 or army["events"] != 2303:
        raise ValueError("Worker or army validation coverage changed")
    gates = {"first_pylon": first_opening["BuildPylon"] >= 133,
             "first_gateway": first_opening["BuildGateway"] >= 112,
             "worker": worker["correct"] / worker["events"] >= .8829287392325763 - .02,
             "army": army["correct"] > 238,
             "deeper": sum(v["correct"] for v in milestones.values()) > 461}
    return {"unweighted": True, "role": "existing model-selection validation, not untouched test set",
            **totals, "accuracy": totals["correct"] / totals["events"],
            "cross_entropy": ce / totals["events"], "wait_mae_seconds": wait_error / totals["events"],
            "categories": by_category, "matchups": by_matchup, "first_opening": first_opening,
            "deep_milestones": milestones, "gates": gates, "gate_qualified": all(gates.values()),
            "all_logits_wait_parent_parity": True if parity else None}


def admission(args):
    # Import is delayed so --help and pure resume/lease tests need no sidecar.
    from pluto_sc2.own_hud_features_v1 import load_hud_sidecar
    records, partitions, fingerprints, pins = prior.load_dataset(args.dataset)
    sequence_path = Path(args.dataset).resolve() / "sequences.jsonl"
    if pins[str(sequence_path)] != SEQUENCE_SHA:
        raise ValueError("HUD v1 only admits the frozen619 sequence corpus")
    features, sidecar_pins = load_hud_sidecar(args.hud_sidecar, dataset=args.dataset)
    review_path = Path(args.hud_review).resolve()
    review_raw = review_path.read_bytes()
    review = json.loads(review_raw)
    if (prior.bytes_sha(review_raw) != HUD_REVIEW_SHA
            or review.get("schema") != "independent-own-hud-sidecar-review-v1"
            or review.get("status") != "passed" or review.get("source_inputs_unchanged") is not True
            or review.get("target_rows_rederived_exactly") != 152312
            or review.get("strict_sample_before_anchor_before_target_verified") is not True):
        raise ValueError("Complete independent real-HUD proof is required")
    for path, value in review["source_and_input_hashes"].items():
        if path in sidecar_pins and sidecar_pins[path] != value:
            raise ValueError("HUD proof and admitted source disagree")
        sidecar_pins[path] = value
    sidecar_pins[str(review_path)] = HUD_REVIEW_SHA
    for path, value in sidecar_pins.items():
        if path in pins and pins[path] != value:
            raise ValueError("Sidecar and original sequence provenance disagree")
        pins[path] = value
    parent_path = Path(args.parent_run).resolve() / "Protoss-best.pt"
    parent_raw = parent_path.read_bytes()
    if prior.bytes_sha(parent_raw) != PARENT_SHA:
        raise ValueError("HUD adapter requires the selected immutable P3492 parent")
    parent = torch.load(io.BytesIO(parent_raw), map_location="cpu", weights_only=True)
    prior.validate_parent(parent, race="Protoss", horizon=480,
                          partitions={r["replay_id"]: r["partition"] for r in records},
                          fixed_partitions=partitions, perspective_hashes=fingerprints)
    if (parent["updates"] != 3492 or parent["fixed_partitions"] != partitions
            or parent["perspective_hashes"] != fingerprints):
        raise ValueError("Parent/data exact coverage changed")
    pins[str(parent_path)] = PARENT_SHA
    baseline_path = Path(args.baseline_audit).resolve()
    baseline_raw = baseline_path.read_bytes()
    if prior.bytes_sha(baseline_raw) != BASELINE_SHA:
        raise ValueError("Frozen milestone cohort changed")
    baseline = json.loads(baseline_raw)
    ids = {}
    for event in baseline["events"]:
        if event["milestone"] in DEEP:
            identity = event["replay_id"], event["player_id"], event["target_event_ordinal"]
            ids.setdefault(identity, []).append(event["milestone"])
    pins[str(baseline_path)] = BASELINE_SHA
    raw = [json.loads(line) for line in sequence_path.read_bytes().splitlines()]
    names = {}
    for row in raw:
        if row["race"] == "Protoss" and row["partition"] == "train":
            for event in row["events"]:
                names.setdefault(event["token"], set()).add(event["decoded_name"])
    categories = {}
    for token, variants in names.items():
        name = next(iter(variants)) if len(variants) == 1 else ""
        category = ("worker" if name == "TrainProbe" else "other" if name == "BuildOracleStasisTrap"
                    else "army_production" if name.startswith(("Train", "WarpIn"))
                    else "building" if name.startswith("Build") else "research" if name.startswith(("Research", "Upgrade", "Evolve"))
                    else "other")
        categories[token] = category, name
    train = weighted_training_examples(records)
    valid = [(r, i) for r in records if r["race"] == "Protoss" and r["partition"] == "validation"
             for i, c in enumerate(r["commands"]) if c["game_loop"] <= 480 * 22.4]
    if math.ceil(len(train) / 128) != 378 or len(valid) != 11807:
        raise ValueError("Frozen training/validation counts changed")
    if any(feature_key(r, i) not in features for r, i in train + valid):
        raise ValueError("Missing admitted HUD target")
    if set(ids) - {feature_key(r, i) for r, i in valid}:
        raise ValueError("Milestones contain a non-validation target")
    for path in (Path(__file__), ROOT / "src/pluto_sc2/build_order_hud_prior_v1.py",
                 ROOT / "src/pluto_sc2/build_order_imitation_v1.py", Path(prior.__file__)):
        pins[str(path.resolve())] = prior.sha(path)
    return parent, parent_raw, train, valid, features, categories, ids, pins


def continuation_permission(path, output, checkpoint_sha, checkpoint, pins):
    raw = Path(path).read_bytes()
    value = json.loads(raw)
    review_sha = prior.bytes_sha(raw)
    if (value.get("schema") != "own-command-hud-continuation-review-v1" or value.get("approved") is not True
            or Path(value.get("run_path", "")).resolve() != output.resolve()
            or value.get("parent_checkpoint_sha256") != PARENT_SHA
            or value.get("initial_parity_passed") is not True
            or value.get("frozen_base_and_optimizer_verified") is not True
            or value.get("source_hashes") != pins
            or not (value.get("checkpoint_sha256") == checkpoint_sha
                    or checkpoint.get("continuation_review_sha256") == review_sha)):
        raise ValueError("Continuous mode requires an exact independently reviewed continuation receipt")
    return review_sha


def run(args):
    if (args.threads not in (1, 2) or not 1 <= args.epochs <= 2 or not 60 <= args.wall_seconds <= 600
            or args.continuous and (not args.resume or not args.continuation_review)):
        raise ValueError("Require bounded2-pass/600s or explicitly reviewed continuous resume, max2CPU threads")
    output = Path(args.output).resolve()
    if output.exists() != args.resume:
        raise ValueError("Fresh run needs a new output; resume needs the existing run")
    started = time.monotonic()
    torch.set_num_threads(args.threads)
    with TrainingLease(ROOT / "runs/build-order-hud-v1/.trainer.lock") as lease:
        parent, parent_raw, train, valid, features, categories, milestone_ids, pins = admission(args)
        signatures = {p: (Path(p).stat().st_size, Path(p).stat().st_mtime_ns) for p in pins}
        stops = [ROOT / "STOP", output / "STOP", Path(args.dataset) / "STOP", Path(args.hud_sidecar) / "STOP",
                 Path(args.parent_run) / "STOP"]

        def unchanged():
            if any(prior.sha(p) != value for p, value in pins.items()):
                raise ValueError("Pinned source, checkpoint or data changed")

        def check():
            if any(p.exists() for p in stops):
                raise InterruptedError("STOP respected")
            if not args.continuous and time.monotonic() - started > args.wall_seconds:
                raise TimeoutError("Bounded HUD proof wall limit")
            if psutil.virtual_memory().available < 10 * 1024**3:
                raise InterruptedError("Available RAM below10GiB resource floor")
            if shutil.disk_usage(output.parent).free < 10 * 1024**3:
                raise InterruptedError("Disk free below10GiB storage floor")
            if any((Path(p).stat().st_size, Path(p).stat().st_mtime_ns) != sig for p, sig in signatures.items()):
                unchanged()
                raise ValueError("Pinned file metadata changed; review required")

        check()
        unchanged()
        model = HudResidualPrior(parent["parameters"])
        model.vocabulary_size = len(parent["vocabulary"])
        optimizer = torch.optim.Adam(model.adapter.parameters(), lr=LR)
        generator = random.Random()
        generator.setstate(parent["python_rng"])
        torch.set_rng_state(parent["torch_rng"])
        base_optimizer = copy.deepcopy(parent["optimizer"])
        base_parameter_sha, base_optimizer_sha = tensor_tree_sha(parent["parameters"]), tensor_tree_sha(base_optimizer)
        adapter_updates, serial = 0, 0
        cursor = {"epochs_completed": 0, "phase": "ready", "order": [], "next_offset": 0}
        continuation_sha = None
        history, best, qualified = [], None, None
        history_chain = None
        initial_parity = None
        if args.resume:
            latest_raw = (output / "latest.json").read_bytes()
            latest = json.loads(latest_raw)
            checkpoint_raw = (output / latest["checkpoint"]).read_bytes()
            if prior.bytes_sha(checkpoint_raw) != latest["checkpoint_sha256"]:
                raise ValueError("Latest pointer does not bind checkpoint bytes")
            saved = torch.load(io.BytesIO(checkpoint_raw), map_location="cpu", weights_only=True)
            if (saved.get("schema") != SCHEMA or saved.get("contract") != CONTRACT or saved.get("source_hashes") != pins
                    or saved.get("parent_checkpoint_sha256") != PARENT_SHA or saved.get("base_updates") != 3492
                    or saved.get("base_parameter_sha256") != base_parameter_sha
                    or saved.get("base_optimizer_sha256") != base_optimizer_sha
                    or saved.get("threads") != args.threads
                    or prior.sha(output / "Protoss-parent-exact.pt") != PARENT_SHA):
                raise ValueError("Resume changed immutable base/optimizer/data/source contract")
            model.adapter.load_state_dict(saved["adapter_parameters"], strict=True)
            optimizer.load_state_dict(saved["adapter_optimizer"])
            adapter_updates, serial = saved["adapter_updates"], saved["serial"]
            cursor, history, best, qualified = saved["cursor"], saved["history"], saved["best"], saved["qualified_best"]
            history_chain = saved["history_chain_sha256"]
            verify_epoch_chain(output, cursor["epochs_completed"], history_chain)
            initial_parity = saved["initial_parity"]
            generator.setstate(saved["python_rng"])
            torch.set_rng_state(saved["torch_rng"])
            continuation_sha = saved.get("continuation_review_sha256")
            if args.continuous:
                continuation_sha = continuation_permission(args.continuation_review, output,
                    latest["checkpoint_sha256"], saved, pins)
        else:
            output.mkdir(parents=True)
            with (output / "Protoss-parent-exact.pt").open("xb") as stream:
                stream.write(parent_raw)
        verify_adapter_optimizer(model, optimizer, adapter_updates)
        validate_cursor(cursor, len(train), adapter_updates)
        if not args.continuous and adapter_updates > 756:
            raise ValueError("Bounded mode cannot advance a continuous run")
        status = {"schema": SCHEMA, "contract": CONTRACT, "status": "running", **lease.identity,
                  "started_at": now(), "continuous": args.continuous, "base_updates": 3492,
                  "source_hashes": pins, "parent_checkpoint_sha256": PARENT_SHA,
                  "native_games": 0, "live_model_promoted": False, "optimizer_scope": "adapter only",
                  "initial_parity": initial_parity, "adapter_learning_rate": LR}
        last_save = time.monotonic()

        def save(reason, allocated=None):
            nonlocal serial, last_save
            verify_frozen_base(model, parent["parameters"])
            verify_adapter_optimizer(model, optimizer, adapter_updates)
            if not exact(base_optimizer, parent["optimizer"]):
                raise ValueError("Inert original Adam was mutated")
            serial, filename = allocated or allocate_snapshot(output, serial, adapter_updates)
            if (output / filename).exists():
                raise ValueError("Allocated immutable snapshot appeared unexpectedly")
            value = {"schema": SCHEMA, "contract": CONTRACT, "serial": serial,
                     "parent_checkpoint_sha256": PARENT_SHA,
                     "base_snapshot": "Protoss-parent-exact.pt", "base_parameter_sha256": base_parameter_sha,
                     "base_optimizer_sha256": base_optimizer_sha, "base_updates": 3492,
                     "adapter_parameters": model.adapter.state_dict(), "adapter_optimizer": optimizer.state_dict(),
                     "adapter_updates": adapter_updates, "vocabulary": parent["vocabulary"],
                     "source_hashes": pins, "cursor": copy.deepcopy(cursor), "history": history,
                     "history_chain_sha256": history_chain, "threads": args.threads,
                     "best": best, "qualified_best": qualified, "initial_parity": initial_parity,
                     "python_rng": generator.getstate(), "torch_rng": torch.get_rng_state(),
                     "continuation_review_sha256": continuation_sha, "reason": reason,
                     "native_actor_connected": False, "live_model_promoted": False}
            buffer = io.BytesIO()
            torch.save(value, buffer)
            data = buffer.getvalue()
            with (output / filename).open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            pointer = {"checkpoint": filename, "checkpoint_sha256": prior.bytes_sha(data),
                       "base_updates": 3492, "adapter_updates": adapter_updates, "serial": serial}
            prior.write_json(output / "latest.json", pointer)
            status.update(adapter_updates=adapter_updates, cursor=cursor, latest=pointer,
                          history=history, best=best, qualified_best=qualified, initial_parity=initial_parity)
            prior.write_json(output / "status.json", status)
            last_save = time.monotonic()
            return pointer

        try:
            if initial_parity is None:
                initial = evaluate(model, valid, parent["vocabulary"], features, categories, milestone_ids, check, parity=True)
                with torch.inference_mode():
                    for offset in range(0, min(1024, len(train)), 128):
                        check()
                        t, times, lengths, _, _, hud = batch(train[offset:offset + 128], parent["vocabulary"], features)
                        actual = model(t, times, lengths, len(parent["vocabulary"]), hud)
                        expected = model.base(t, times, lengths, len(parent["vocabulary"]))
                        if not all(torch.equal(a, b) for a, b in zip(actual, expected)):
                            raise ValueError("Representative TRAIN parity failed")
                initial_parity = {"passed": True, "validation_examples": len(valid), "train_examples": min(1024, len(train)),
                                  "logits_wait_masks_exact": True, "initial_validation": initial}
                allocation = allocate_snapshot(output, serial, adapter_updates)
                best = {"checkpoint": allocation[1], "adapter_updates": 0,
                        "cross_entropy": initial["cross_entropy"]}
                save("initial_zero_adapter_parity", allocation)
            if initial_parity.get("passed") is not True:
                raise ValueError("Continuation lacks exact initial parity")
            while args.continuous or cursor["epochs_completed"] < args.epochs:
                check()
                unchanged()
                if cursor["phase"] == "ready":
                    cursor.update(phase="training", order=next_order(train, generator), next_offset=0)
                if cursor["phase"] == "training":
                    model.train()
                    while cursor["next_offset"] < len(train):
                        check()
                        if not args.continuous and adapter_updates >= 756:
                            raise TimeoutError("Bounded756 adapter-update cap")
                        start = cursor["next_offset"]
                        chunk = [train[i] for i in cursor["order"][start:start + 128]]
                        step(model, optimizer, batch(chunk, parent["vocabulary"], features), before_step=check)
                        adapter_updates += 1
                        cursor["next_offset"] += len(chunk)
                        verify_frozen_base(model, parent["parameters"])
                        if time.monotonic() - last_save >= 60:
                            save("periodic_durable_cursor")
                    cursor["phase"] = "evaluation"
                metrics = evaluate(model, valid, parent["vocabulary"], features, categories, milestone_ids, check)
                unchanged()
                cursor.update(epochs_completed=cursor["epochs_completed"] + 1, phase="ready", order=[], next_offset=0)
                record = {"epoch": cursor["epochs_completed"], "base_updates": 3492,
                          "adapter_updates": adapter_updates, "metrics": metrics,
                          "adapter_parameter_sha256": tensor_tree_sha(model.adapter.state_dict())}
                history_chain = append_epoch_receipt(output, record, history_chain)
                history = [*history[-7:], record]
                # Reference the upcoming immutable full checkpoint, never mutable aliases.
                allocation = allocate_snapshot(output, serial, adapter_updates)
                reference = {"checkpoint": allocation[1],
                             "adapter_updates": adapter_updates, "cross_entropy": metrics["cross_entropy"]}
                if best is None or metrics["cross_entropy"] < best["cross_entropy"]:
                    best = reference
                if metrics["gate_qualified"] and (qualified is None or metrics["cross_entropy"] < qualified["cross_entropy"]):
                    qualified = reference
                save("completed_epoch_evaluated", allocation)
                print(json.dumps({"epoch": cursor["epochs_completed"], "adapter_updates": adapter_updates,
                                  "cross_entropy": metrics["cross_entropy"], "gates": metrics["gates"]}), flush=True)
            status["status"] = "bounded_complete"
        except (InterruptedError, TimeoutError) as exc:
            status.update(status="stopped_safely", reason=str(exc))
        except Exception as exc:
            status.update(status="failed", error=repr(exc))
            raise
        finally:
            try:
                source_unchanged = all(prior.sha(p) == h for p, h in pins.items())
            except OSError:
                source_unchanged = False
            status.update(finished_at=now(), process_active=False,
                          source_inputs_unchanged=source_unchanged,
                          elapsed_seconds=time.monotonic() - started)
            save("final_durability")


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--dataset", required=True)
    value.add_argument("--hud-sidecar", required=True)
    value.add_argument("--hud-review", required=True)
    value.add_argument("--parent-run", required=True)
    value.add_argument("--baseline-audit", required=True)
    value.add_argument("--output", required=True)
    value.add_argument("--epochs", type=int, default=2)
    value.add_argument("--wall-seconds", type=int, default=600)
    value.add_argument("--threads", type=int, default=2)
    value.add_argument("--resume", action="store_true")
    value.add_argument("--continuous", action="store_true")
    value.add_argument("--continuation-review")
    return value


if __name__ == "__main__":
    run(parser().parse_args())
