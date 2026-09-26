"""Read-only byte-exact restoration and held-out evaluation of the HUD adapter.

No optimizer is constructed or stepped. Continuation approval, when requested,
concerns technical integrity of offline fitting, never quality or live promotion.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import random
import sys
import time
from types import SimpleNamespace

import psutil
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from scripts import train_build_order_hud_v1 as trainer  # noqa: E402
from pluto_sc2.build_order_hud_prior_v1 import HudResidualPrior, verify_frozen_base  # noqa: E402

TRAINER_SHA = "3960cb8f3ca13bc6b728920d5dea1f7c9d84781da98585ea2984dc8602180bbd"
MODEL_SHA = "7907948e14c11e6435132e8c7f1c9a8b25fa1045bc116c274b881b14fe738673"
SCHEMA = "independent-own-command-hud-reload-v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def exact(a, b):
    if isinstance(a, torch.Tensor):
        return (isinstance(b, torch.Tensor) and a.dtype == b.dtype and a.shape == b.shape
                and a.detach().cpu().contiguous().numpy().tobytes() == b.detach().cpu().contiguous().numpy().tobytes())
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(exact(value, b[key]) for key, value in a.items())
    if isinstance(a, (list, tuple)):
        return type(a) is type(b) and len(a) == len(b) and all(exact(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def tree_sha(value):
    digest = hashlib.sha256()
    def visit(node):
        if isinstance(node, torch.Tensor):
            digest.update(str((str(node.dtype), tuple(node.shape))).encode())
            digest.update(node.detach().cpu().contiguous().numpy().tobytes())
        elif isinstance(node, dict):
            for key in sorted(node, key=str):
                digest.update(repr(key).encode())
                visit(node[key])
        elif isinstance(node, (tuple, list)):
            digest.update(type(node).__name__.encode())
            for child in node:
                visit(child)
        else:
            digest.update(repr(node).encode())
    visit(value)
    return digest.hexdigest()


def verify_adapter_state(saved):
    updates = saved["adapter_updates"]
    require(type(updates) is int and updates in (0, 378, 756), "Unexpected bounded adapter age")
    parameters = saved["adapter_parameters"]
    require(set(parameters) == {"weight"}, "Unexpected adapter parameter namespace")
    weight = parameters["weight"]
    require(weight.shape == (512, 8) and weight.dtype == torch.float32 and bool(torch.isfinite(weight).all()),
            "Adapter shape, dtype or finite check failed")
    optimizer = saved["adapter_optimizer"]
    require(set(optimizer) == {"state", "param_groups"} and len(optimizer["param_groups"]) == 1,
            "Adapter Adam schema changed")
    group = optimizer["param_groups"][0]
    require(group["params"] == [0] and group["lr"] == .0005 and group["betas"] == (.9, .999)
            and group["eps"] == 1e-8 and group["weight_decay"] == 0 and group["amsgrad"] is False
            and group["maximize"] is False, "Adapter Adam parameters/hyperparameters changed")
    if updates == 0:
        require(optimizer["state"] == {} and exact(weight, torch.zeros_like(weight)), "Initial adapter or Adam not zero")
    else:
        require(set(optimizer["state"]) == {0}, "Adapter Adam contains unexpected parameter state")
        state = optimizer["state"][0]
        require(set(state) == {"step", "exp_avg", "exp_avg_sq"} and float(state["step"]) == updates,
                "Adapter Adam age differs")
        for key in ("exp_avg", "exp_avg_sq"):
            require(state[key].shape == weight.shape and state[key].dtype == weight.dtype
                    and bool(torch.isfinite(state[key]).all()), "Adapter Adam moments invalid")
        require(bool((state["exp_avg_sq"] >= 0).all()), "Negative second Adam moment")
    epoch = updates // 378
    require(saved["cursor"] == {"epochs_completed": epoch, "phase": "ready", "order": [], "next_offset": 0},
            "Evaluated checkpoint cursor and age disagree")
    return epoch


def evaluate(model, examples, vocabulary, features, categories, milestones, *, initial=False):
    """Independent reduction; training's evaluator is not called."""
    model.eval()
    totals = Counter(events=0, correct=0, top3=0)
    groups, matchups, deep, opening, seen = {}, {}, {}, Counter(), set()
    ce, timing, missing_rows = 0., 0., 0
    prediction_digest, logits_digest = hashlib.sha256(), hashlib.sha256()
    with torch.inference_mode():
        for offset in range(0, len(examples), 256):
            chunk = examples[offset:offset + 256]
            tokens, times, lengths, targets, waits, hud = trainer.batch(chunk, vocabulary, features)
            logits, predicted_wait = model(tokens, times, lengths, len(vocabulary), hud)
            base_logits, base_wait = model.base(tokens, times, lengths, len(vocabulary))
            require(exact(predicted_wait, base_wait), "Frozen timing head changed")
            require(bool(torch.isfinite(logits).all()) and bool(torch.isfinite(predicted_wait).all()), "Nonfinite inference")
            require(bool((logits[:, :2] == -1e9).all()) and bool((logits[:, len(vocabulary) + 2:] == -1e9).all()),
                    "Unknown token mask changed")
            if initial:
                require(exact(logits, base_logits), "Initial logits are not byte-exact to parent")
            missing = ~hud[:, 7].bool()
            missing_rows += int(missing.sum())
            require(exact(logits[missing], base_logits[missing]), "Missing-all HUD changed base logits")
            predictions = logits.argmax(-1)
            top3 = logits.topk(3, dim=-1).indices
            prediction_digest.update(predictions.numpy().tobytes())
            logits_digest.update(logits.numpy().tobytes())
            ce += float(torch.nn.functional.cross_entropy(logits, targets, reduction="sum"))
            timing += float((torch.expm1(predicted_wait.clamp(max=15)) - torch.expm1(waits)).abs().sum())
            for j, (row, index) in enumerate(chunk):
                correct = int(predictions[j] == targets[j])
                totals.update(events=1, correct=correct, top3=int((top3[j] == targets[j]).any()))
                category, name = categories[trainer.prior.token_key(row["commands"][index])]
                groups.setdefault(category, Counter()).update(events=1, correct=correct)
                matchups.setdefault(row["matchup"], Counter()).update(events=1, correct=correct)
                key = row["replay_id"], row["player_id"], name
                if name in ("BuildPylon", "BuildGateway") and key not in seen:
                    seen.add(key)
                    opening[name] += correct
                identity = row["replay_id"], row["player_id"], row["commands"][index]["source_event_index"]
                for label in milestones.get(identity, []):
                    deep.setdefault(label, Counter()).update(events=1, correct=correct)
    require(totals["events"] == 11807 and groups["worker"]["events"] == 5108
            and groups["army_production"]["events"] == 2303 and sum(x["events"] for x in deep.values()) == 970,
            "Held-out cohort counts differ")
    gates = {"first_pylon": opening["BuildPylon"] >= 133, "first_gateway": opening["BuildGateway"] >= 112,
             "worker": groups["worker"]["correct"] / 5108 >= .8829287392325763 - .02,
             "army": groups["army_production"]["correct"] > 238,
             "deeper": sum(x["correct"] for x in deep.values()) > 461}
    metrics = {"unweighted": True, "role": "existing model-selection validation, not untouched test set",
               **totals, "accuracy": totals["correct"] / totals["events"], "cross_entropy": ce / totals["events"],
               "wait_mae_seconds": timing / totals["events"], "categories": groups, "matchups": matchups,
               "first_opening": opening, "deep_milestones": deep, "gates": gates,
               "gate_qualified": all(gates.values()), "all_logits_wait_parent_parity": True if initial else None}
    return metrics, {"prediction_sha256": prediction_digest.hexdigest(), "logits_sha256": logits_digest.hexdigest(),
                     "wait_byte_exact_to_parent": True, "missing_all_rows": missing_rows,
                     "missing_all_logits_byte_exact_to_parent": True, "known_vocabulary_masks_exact": True}


def run(args):
    start = time.monotonic()
    torch.set_num_threads(2)
    run_path, output = Path(args.run).resolve(), Path(args.output).resolve()
    require(not output.exists(), "Review output must be new")
    if args.continuation_review:
        require(not Path(args.continuation_review).exists(), "Continuation receipt must be new")
    require(sha(trainer.__file__) == TRAINER_SHA and sha(ROOT / "src/pluto_sc2/build_order_hud_prior_v1.py") == MODEL_SHA,
            "Reviewed source versions differ")
    hashes = {str(Path(__file__).resolve()): sha(__file__)}
    def read_json(path):
        path = Path(path).resolve()
        raw = path.read_bytes()
        hashes[str(path)] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)
    status, latest = read_json(run_path / "status.json"), read_json(run_path / "latest.json")
    require(status["status"] == "bounded_complete" and status["process_active"] is False
            and status["source_inputs_unchanged"] is True and status["adapter_updates"] == 756
            and status["continuous"] is False, "Bounded proof is not finalized")
    if psutil.pid_exists(status["pid"]):
        require(psutil.Process(status["pid"]).create_time() != status["pid_creation_time"], "Trainer remains active")
    pins = status["source_hashes"]
    require(all(sha(path) == value for path, value in pins.items()), "Pinned source/input changed before reload")
    def path_for(value):
        matches = [path for path, recorded in pins.items() if recorded == value]
        require(len(matches) == 1, "Expected unique pinned input")
        return Path(matches[0])
    admission = SimpleNamespace(dataset=path_for(trainer.SEQUENCE_SHA).parent,
        hud_sidecar=ROOT / "runs/own-hud-feature-extraction-v1/data-v1",
        hud_review=path_for(trainer.HUD_REVIEW_SHA), parent_run=path_for(trainer.PARENT_SHA).parent,
        baseline_audit=path_for(trainer.BASELINE_SHA))
    parent, parent_raw, train, valid, features, categories, milestones, actual_pins = trainer.admission(admission)
    require(actual_pins == pins, "Independent admission pins differ")
    base_copy = run_path / "Protoss-parent-exact.pt"
    require(base_copy.read_bytes() == parent_raw, "Immutable base snapshot is not byte-exact original")
    hashes[str(base_copy)] = trainer.PARENT_SHA
    require(all(float(s["step"]) == 3492 for s in parent["optimizer"]["state"].values()), "Original Adam age changed")
    parameter_digest, optimizer_digest = tree_sha(parent["parameters"]), tree_sha(parent["optimizer"])
    paths = sorted(run_path.glob("checkpoint-*.pt"))
    require(len(paths) == 4, "Bounded proof checkpoint coverage differs")
    candidates, epochs = [], {}
    last_saved = None
    for path in paths:
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        hashes[str(path)] = digest
        saved = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=True)
        require(saved["schema"] == "own-command-hud-prior-v1" and saved["contract"] == trainer.CONTRACT
                and saved["source_hashes"] == pins and saved["parent_checkpoint_sha256"] == trainer.PARENT_SHA
                and saved["base_snapshot"] == "Protoss-parent-exact.pt" and saved["base_updates"] == 3492
                and saved["base_parameter_sha256"] == parameter_digest and saved["base_optimizer_sha256"] == optimizer_digest
                and saved["threads"] == 2 and saved["native_actor_connected"] is False and saved["live_model_promoted"] is False
                and exact(saved["vocabulary"], parent["vocabulary"]), "Checkpoint base/source/schema contract differs")
        epoch = verify_adapter_state(saved)
        rng = random.Random()
        rng.setstate(parent["python_rng"])
        for _ in range(epoch):
            order = list(range(len(train)))
            rng.shuffle(order)
        require(exact(saved["python_rng"], rng.getstate()) and exact(saved["torch_rng"], parent["torch_rng"]),
                "Saved deterministic RNG lineage differs")
        trainer.verify_epoch_chain(run_path, epoch, saved["history_chain_sha256"])
        model = HudResidualPrior(parent["parameters"])
        model.adapter.load_state_dict(saved["adapter_parameters"], strict=True)
        verify_frozen_base(model, parent["parameters"])
        if epoch in epochs:
            require(exact(saved["adapter_parameters"], last_saved["adapter_parameters"])
                    and exact(saved["adapter_optimizer"], last_saved["adapter_optimizer"]), "Final durability changed model/Adam")
            metrics, proof = epochs[epoch]
        else:
            metrics, proof = evaluate(model, valid, parent["vocabulary"], features, categories, milestones, initial=epoch == 0)
            epochs[epoch] = metrics, proof
        if epoch == 0:
            require(saved["reason"] == "initial_zero_adapter_parity" and saved["adapter_updates"] == 0,
                    "Initial checkpoint is not zero-update")
            expected = saved["initial_parity"]["initial_validation"]
            with torch.inference_mode():
                for offset in range(0, 1024, 128):
                    t, times, lengths, _, _, hud = trainer.batch(train[offset:offset + 128], parent["vocabulary"], features)
                    actual = model(t, times, lengths, len(parent["vocabulary"]), hud)
                    wanted = model.base(t, times, lengths, len(parent["vocabulary"]))
                    require(all(exact(a, b) for a, b in zip(actual, wanted)), "TRAIN initial byte parity differs")
        else:
            receipt = read_json(run_path / f"epoch-{epoch:06d}-metrics.json")
            require(receipt["adapter_parameter_sha256"] == tree_sha(saved["adapter_parameters"]), "Epoch metric adapter hash differs")
            expected = receipt["metrics"]
            require(saved["history"][-1]["metrics"] == expected, "Checkpoint does not bind evaluated metrics")
        require(metrics == expected, "Independent full held-out evaluation differs from saved metrics")
        require(saved["initial_parity"]["passed"] is True and saved["initial_parity"]["validation_examples"] == 11807
                and saved["initial_parity"]["train_examples"] == 1024, "Initial parity receipt differs")
        verify_frozen_base(model, parent["parameters"])
        candidates.append({"checkpoint": path.name, "sha256": digest, "epoch": epoch,
            "base_updates": 3492, "adapter_updates": saved["adapter_updates"], "adam_step": saved["adapter_updates"],
            "independently_verified": True, "metrics": metrics, "inference_proof": proof})
        last_saved = saved
    require(set(epochs) == {0, 1, 2} and latest == status["latest"]
            and latest["checkpoint"] == paths[-1].name and latest["checkpoint_sha256"] == hashes[str(paths[-1])]
            and exact(last_saved["cursor"], status["cursor"]), "Final pointer/status/checkpoint binding differs")
    require(last_saved["qualified_best"] == status["qualified_best"], "Qualified checkpoint pointer differs")
    for reference in (last_saved["best"], last_saved["qualified_best"]):
        if reference is not None:
            matches = [x for x in candidates if x["checkpoint"] == reference["checkpoint"]]
            require(len(matches) == 1 and matches[0]["adapter_updates"] == reference["adapter_updates"]
                    and matches[0]["metrics"]["cross_entropy"] == reference["cross_entropy"], "Best pointer is not verified snapshot")
    hashes.update(pins)
    require(all(sha(path) == value for path, value in hashes.items()), "Input/checkpoint/source changed during reload")
    report = {"schema": SCHEMA, "status": "passed", "run_path": str(run_path),
        "finalized_status_path": str(run_path / "status.json"), "finalized_status_sha256": hashes[str(run_path / "status.json")],
        "parent_checkpoint_sha256": trainer.PARENT_SHA, "initial_parity_passed": True,
        "frozen_base_and_optimizer_verified": True, "base_parameter_sha256": parameter_digest,
        "base_optimizer_sha256": optimizer_digest, "base_updates": 3492, "final_adapter_updates": 756,
        "dtype": "float32; byte-exact comparisons, no quantization", "validation_examples_per_epoch": 11807,
        "train_initial_parity_examples": 1024, "candidates": candidates, "source_hashes": pins,
        "source_and_input_hashes": hashes, "source_inputs_unchanged": True,
        "checkpoint_sha256": latest["checkpoint_sha256"], "optimizer_steps_executed": 0, "native_games": 0,
        "live_promotion": False, "quality_gate_qualified": status["qualified_best"] is not None,
        "elapsed_seconds": time.monotonic() - start}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    if args.continuation_review:
        permission = {"schema": "own-command-hud-continuation-review-v1", "approved": True,
            "approval_scope": "technical integrity for already user-authorized continuous offline adapter fitting",
            "run_path": str(run_path), "parent_checkpoint_sha256": trainer.PARENT_SHA,
            "checkpoint_sha256": latest["checkpoint_sha256"], "initial_parity_passed": True,
            "frozen_base_and_optimizer_verified": True, "source_hashes": pins,
            "independent_reload_path": str(output), "independent_reload_sha256": sha(output),
            "quality_gate_qualified": status["qualified_best"] is not None,
            "quality_failure_is_not_training_authorization_withdrawal": True,
            "native_execution_authorized": False, "live_promotion_authorized": False,
            "unchanged_input_fog_and_gameplay_constraints_required": True}
        target = Path(args.continuation_review)
        target.write_text(json.dumps(permission, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        trainer.continuation_permission(target, run_path, latest["checkpoint_sha256"], last_saved, pins)
    print(json.dumps({key: report[key] for key in ("status", "base_updates", "final_adapter_updates", "quality_gate_qualified", "elapsed_seconds")}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--continuation-review")
    run(parser.parse_args())
