"""Bounded incremental own-command imitation, separate from the native actor."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import numpy as np  # noqa: E402
import psutil  # noqa: E402
import torch  # noqa: E402
from pluto_sc2.build_order_imitation_v1 import (  # noqa: E402
    SCHEMA,
    BuildOrderPrior,
    collate_examples,
    extend_vocabulary,
    imitation_loss,
    prefix_example,
    validate_record,
    token_key,
)

TRAINING_CONTRACT = "causal-own-command-prior-training-v2"


def bytes_sha(value):
    return hashlib.sha256(value).hexdigest()


def model_contract():
    return {"schema": SCHEMA, "training_contract": TRAINING_CONTRACT,
            "model_source_sha256": sha(ROOT / "src/pluto_sc2/build_order_imitation_v1.py"),
            "capacity": 512, "history": 32, "pooled_matchups": True,
            "native_ability_ids": False, "same_loop_commands_excluded": True}


def perspective_key(record):
    return f"{record['replay_id']}:{record['player_id']}"


def load_dataset(dataset):
    """Hash exactly the bytes parsed; bind identities and weights to extraction."""
    dataset = Path(dataset).resolve()
    result_path, sequence_path = dataset / "result.json", dataset / "sequences.jsonl"
    result_bytes, sequence_bytes = result_path.read_bytes(), sequence_path.read_bytes()
    result = json.loads(result_bytes)
    if (result.get("schema") != "own-macro-attempt-sequences-v1" or result.get("status") != "complete"
            or result.get("source_unchanged") is not True or result.get("all_originals_unchanged") is not True
            or result.get("eligible_for_causal_raw_macro_prior") is not True
            or result.get("alphastar_training_eligible") is not False or result.get("errors") != []
            or result.get("sequences_sha256") != bytes_sha(sequence_bytes)):
        raise ValueError("Extraction receipt does not bind complete own-command sequence bytes")
    source = Path(result["source_manifest"])
    if not source.is_absolute():
        raise ValueError("Extraction source manifest must be an absolute immutable path")
    manifest_bytes = source.read_bytes()
    if bytes_sha(manifest_bytes) != result["source_manifest_sha256"]:
        raise ValueError("Extraction source manifest hash changed")
    manifest = json.loads(manifest_bytes)
    if manifest.get("schema") != "incremental-own-intention-batch-v1":
        raise ValueError("Unsupported whole-replay manifest")
    raw = [json.loads(line) for line in sequence_bytes.splitlines() if line]
    expected = {perspective_key(row): row for row in manifest["perspectives"]}
    if (len(expected) != len(manifest["perspectives"]) or len(raw) != result["perspectives"]
            or len(raw) != len(expected) or {perspective_key(row) for row in raw} != set(expected)):
        raise ValueError("Sequence perspective identities differ from manifest")
    records, hashes = [], {}
    for row in raw:
        identity = perspective_key(row)
        metadata = expected[identity]
        allowed = {"PvT": "Protoss", "PvP": "Protoss", "PvZ": "Protoss", "TvP": "Terran", "ZvP": "Zerg"}
        if allowed.get(row["matchup"]) != row["race"]:
            raise ValueError("Matchup/race outside authorized Protoss-centered scope")
        fields = ("replay_id", "player_id", "race", "matchup", "partition",
                  "training_sampling_weight", "evaluation_weight")
        if any(row.get(field) != metadata.get(field) for field in fields):
            raise ValueError("Perspective race/partition/weight metadata changed")
        if (manifest["fixed_partitions"].get(row["replay_id"]) != row["partition"]
                or metadata.get("start_workers") != 8):
            raise ValueError("Eight-worker whole-replay partition differs")
        weight = 2 if row["partition"] == "train" and metadata["perspective"] == "opponent" and metadata["result"] == "Win" else 1
        if row["training_sampling_weight"] != weight or row["evaluation_weight"] != 1:
            raise ValueError("Sampling weight is not the declared single TRAIN opponent-win weighting")
        record = normalize_record(row)
        hashes[identity] = bytes_sha(json.dumps(record, sort_keys=True, separators=(",", ":")).encode())
        records.append(record)
    selected = set(manifest["selected_original_ids"])
    if (selected != {row["replay_id"] for row in records} or len(selected) != result["processed_originals"]
            or result["processed_originals"] != result["originals"]):
        raise ValueError("Replay coverage differs from extraction receipt")
    inputs = {str(result_path): bytes_sha(result_bytes), str(sequence_path): bytes_sha(sequence_bytes),
              str(source.resolve()): bytes_sha(manifest_bytes)}
    return records, manifest["fixed_partitions"], hashes, inputs


def require_cohorts(records, horizon):
    if type(horizon) is not int or not 1 <= horizon <= 7200:
        raise ValueError("Horizon must be1..7200 game seconds")
    for race in ("Protoss", "Terran", "Zerg"):
        for partition in ("train", "validation"):
            if not any(c["game_loop"] <= horizon * 22.4 for row in records
                       if row["race"] == race and row["partition"] == partition for c in row["commands"]):
                raise ValueError(f"Empty {race} {partition} cohort within horizon")


def validate_parent(parent, *, race, horizon, partitions, fixed_partitions, perspective_hashes):
    if (parent.get("schema") != SCHEMA or parent.get("race") != race
            or parent.get("model_contract") != model_contract() or parent.get("horizon_seconds") != horizon
            or parent.get("native_actor_connected") is not False
            or type(parent.get("updates")) is not int or parent["updates"] < 0):
        raise ValueError("Resume model/race/horizon contract mismatch")
    for name, current in (("partitions", partitions), ("fixed_partitions", fixed_partitions),
                          ("perspective_hashes", perspective_hashes)):
        prior = parent.get(name)
        if not isinstance(prior, dict) or not prior or any(current.get(key) != value for key, value in prior.items()):
            raise ValueError(f"Incremental batch removed or changed retained {name}")
    if len(parent["perspective_hashes"]) != 2 * len(parent["partitions"]):
        raise ValueError("Resume perspective content coverage is incomplete")


def verify_optimizer(model, optimizer, updates):
    if type(updates) is not int or updates < 0:
        raise ValueError("Invalid optimizer count")
    if any(group["lr"] != .002 or group["betas"] != (.9, .999) or group["eps"] != 1e-8
           or group["weight_decay"] != 0 or group["amsgrad"] is not False or group["maximize"] is not False
           for group in optimizer.param_groups):
        raise ValueError("Adam hyperparameters differ from bounded objective")
    for parameter in model.parameters():
        if not torch.isfinite(parameter).all():
            raise ValueError("Nonfinite resumed parameters")
        state = optimizer.state.get(parameter, {})
        if updates == 0 and not state:
            continue
        if (set(state) != {"step", "exp_avg", "exp_avg_sq"} or float(state["step"]) != updates
                or any(state[key].shape != parameter.shape or not torch.isfinite(state[key]).all()
                       for key in ("exp_avg", "exp_avg_sq"))):
            raise ValueError("Adam step count/moment schema or finiteness differs")


def load_parent(directory, race, inputs):
    directory = Path(directory).resolve()
    if (directory / "STOP").exists():
        raise InterruptedError("Resume parent STOP respected")
    status_path, checkpoint_path = directory / "status.json", directory / f"{race}-last.pt"
    status_bytes, checkpoint_bytes = status_path.read_bytes(), checkpoint_path.read_bytes()
    status = json.loads(status_bytes)
    expected = status.get("races", {}).get(race, {}).get("last_checkpoint_sha256")
    if status.get("status") not in ("complete", "stopped_at_bound") or bytes_sha(checkpoint_bytes) != expected:
        raise ValueError("Resume checkpoint does not match committed parent status")
    pins = {str(status_path): bytes_sha(status_bytes), str(checkpoint_path): bytes_sha(checkpoint_bytes)}
    if any(path in inputs and inputs[path] != value for path, value in pins.items()):
        raise ValueError("Previously pinned parent bytes changed")
    inputs.update(pins)
    return torch.load(io.BytesIO(checkpoint_bytes), map_location="cpu", weights_only=True)


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    pending = path.with_suffix(".pending")
    pending.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    pending.replace(path)


def normalize_record(record):
    result = {k: record[k] for k in ("replay_id", "player_id", "race", "matchup", "partition")}
    result["weight"] = record["training_sampling_weight"]
    result["commands"] = [
        dict(
            ability_link=e["ability_link"],
            command_index=e["command_index"],
            game_loop=e["game_loop"],
            source_event_index=e["ordinal"],
        )
        for e in record["events"]
    ]
    validate_record(result)
    if result["weight"] not in (1, 2):
        raise ValueError("Only declared once-per-replay sampling weights1/2 allowed")
    if record.get("evaluation_weight") != 1:
        raise ValueError("Evaluation must be unweighted")
    return result


def sample_pass(train, generator):
    """One complete pass plus exactly one extra copy for weight2 perspectives."""
    chosen = [row for row in train for _ in range(int(row["weight"]))]
    generator.shuffle(chosen)
    return chosen


def repeat_last(record, index):
    commands = record["commands"]
    previous = index - 1
    while previous >= 0 and commands[previous]["game_loop"] >= commands[index]["game_loop"]:
        previous -= 1
    return previous >= 0 and token_key(commands[previous]) == token_key(commands[index])


def evaluate(model, records, vocabulary, *, horizon, check):
    model.eval()
    examples = [
        (r, i) for r in records for i, c in enumerate(r["commands"]) if c["game_loop"] <= horizon * 22.4
    ]
    totals = dict(
        events=0, known_targets=0, correct=0, top3=0, cross_entropy_sum=0.0, wait_absolute_error=0.0,
        repeat_last_correct=0, nonrepeat_targets=0, nonrepeat_correct=0,
    )
    groups = {}
    with torch.no_grad():
        for start in range(0, len(examples), 256):
            check()
            chunk = examples[start : start + 256]
            tokens, times, lengths, target, wanted_wait = collate_examples(
                [prefix_example(r, i, vocabulary) for r, i in chunk]
            )
            logits, predicted_wait = model(tokens, times, lengths, len(vocabulary))
            predicted = logits.argmax(-1)
            top = logits.topk(min(3, len(vocabulary)), dim=-1).indices
            known = target >= 2
            ce = torch.zeros_like(wanted_wait)
            ce[known] = torch.nn.functional.cross_entropy(logits[known], target[known], reduction="none")
            error = (torch.expm1(predicted_wait.clamp(max=15)) - torch.expm1(wanted_wait)).abs()
            for j, (r, index) in enumerate(chunk):
                repeated = repeat_last(r, index)
                metrics = dict(
                    events=1,
                    known_targets=int(known[j]),
                    correct=int(predicted[j] == target[j]),
                    top3=int((top[j] == target[j]).any()),
                    cross_entropy_sum=float(ce[j]),
                    wait_absolute_error=float(error[j]),
                    repeat_last_correct=int(repeated),
                    nonrepeat_targets=int(not repeated),
                    nonrepeat_correct=int(not repeated and predicted[j] == target[j]),
                )
                for bucket in (totals, groups.setdefault(r["matchup"], dict.fromkeys(totals, 0.0))):
                    for name, value in metrics.items():
                        bucket[name] += value

    def summarize(bucket):
        return {
            **bucket,
            "accuracy": bucket["correct"] / max(1, bucket["events"]),
            "top3_accuracy": bucket["top3"] / max(1, bucket["events"]),
            "known_target_coverage": bucket["known_targets"] / max(1, bucket["events"]),
            "known_target_cross_entropy": bucket["cross_entropy_sum"] / max(1, bucket["known_targets"]),
            "wait_mae_seconds": bucket["wait_absolute_error"] / max(1, bucket["events"]),
            "repeat_last_baseline_accuracy": bucket["repeat_last_correct"] / max(1, bucket["events"]),
            "nonrepeat_target_accuracy": bucket["nonrepeat_correct"] / max(1, bucket["nonrepeat_targets"]),
            "accuracy_above_repeat_last": (bucket["correct"] - bucket["repeat_last_correct"]) / max(1, bucket["events"]),
        }

    return {
        "unweighted": True,
        "held_out": True,
        "evaluation_role": "whole-replay validation for model selection, not an untouched test set",
        "nonrepeat_definition": "Target differs from last strictly-earlier-loop token; includes first commands",
        **summarize(totals),
        "matchups": {k: summarize(v) for k, v in groups.items()},
    }


def run(args):
    if not 1 <= args.epochs <= 30 or not 60 <= args.wall_seconds <= 1800 or not 1 <= args.threads <= 4:
        raise ValueError("Run outside bounded resource contract")
    dataset, output = Path(args.dataset).resolve(), Path(args.output).resolve()
    if output.exists():
        raise ValueError("Require a fresh immutable training run")
    stops = [ROOT / "STOP", dataset / "STOP", output / "STOP"]
    if args.resume:
        stops.append(Path(args.resume).resolve() / "STOP")
    if any(p.exists() for p in stops):
        raise ValueError("STOP respected")
    records, fixed_partitions, perspective_hashes, inputs = load_dataset(dataset)
    require_cohorts(records, args.horizon_seconds)
    partitions = {}
    for r in records:
        if r["replay_id"] in partitions and partitions[r["replay_id"]] != r["partition"]:
            raise ValueError("Both perspectives must retain one replay partition")
        partitions[r["replay_id"]] = r["partition"]
    identities = [(r["replay_id"], r["player_id"]) for r in records]
    if len(set(identities)) != len(identities):
        raise ValueError("Duplicate perspective")
    inputs.update({
        str(Path(__file__).resolve()): sha(Path(__file__).resolve()),
        str(ROOT / "src/pluto_sc2/build_order_imitation_v1.py"): sha(
            ROOT / "src/pluto_sc2/build_order_imitation_v1.py"
        ),
    })
    torch.set_num_threads(args.threads)
    torch.manual_seed(20260926)
    np.random.seed(20260926)
    generator = random.Random(20260926)
    started = time.monotonic()
    output.mkdir(parents=True)
    status = dict(
        schema=SCHEMA,
        status="running",
        pid=os.getpid(),
        pid_creation_time=psutil.Process().create_time(),
        started_at=datetime.now(timezone.utc).isoformat(),
        source_hashes=inputs,
        unique_replays=len(partitions),
        perspectives=len(records),
        epochs_requested=args.epochs,
        horizon_seconds=args.horizon_seconds,
        model_contract=model_contract(),
        split_counts=dict(Counter(partitions.values())),
        races={},
        native_games=0,
        source_observations="strictly earlier own replay macro-command tokens and timestamps only",
        spectator_state_inputs=False,
        native_actor_connected=False,
        live_model_promoted=False,
        target_semantics="original command attempts; neither accepted actions nor native ability IDs",
        native_translation_required=True,
        model_scope="separate build-order prior, not AlphaStar actor weights",
        matchup_conditioning=False,
        sampling="Each TRAIN perspective once per pass plus one extra copy for declared weight2; no token weights",
    )
    write_json(output / "status.json", status)

    def check():
        if any(p.exists() for p in stops):
            raise InterruptedError("STOP respected")
        if time.monotonic() - started > args.wall_seconds:
            raise TimeoutError("Bounded training wall time reached")

    def unchanged():
        if any(sha(path) != digest for path, digest in inputs.items()):
            raise ValueError("Immutable source or dataset changed")

    try:
        for race in ("Protoss", "Terran", "Zerg"):
            train = [r for r in records if r["race"] == race and r["partition"] == "train"]
            valid = [r for r in records if r["race"] == race and r["partition"] == "validation"]
            if not train or not valid:
                raise ValueError("Each race needs separate TRAIN and validation views")
            parent = None
            if args.resume:
                parent = load_parent(args.resume, race, inputs)
                validate_parent(parent, race=race, horizon=args.horizon_seconds, partitions=partitions,
                                fixed_partitions=fixed_partitions, perspective_hashes=perspective_hashes)
            vocabulary = extend_vocabulary(train, parent["vocabulary"] if parent else None)
            model = BuildOrderPrior()
            optimizer = torch.optim.Adam(model.parameters(), lr=0.002)
            updates = 0
            if parent:
                model.load_state_dict(parent["parameters"], strict=True)
                optimizer.load_state_dict(parent["optimizer"])
                updates = parent["updates"]
                generator.setstate(parent["python_rng"])
                torch.set_rng_state(parent["torch_rng"])
            verify_optimizer(model, optimizer, updates)

            def checkpoint_value(epoch):
                return dict(schema=SCHEMA, race=race, parameters=model.state_dict(), optimizer=optimizer.state_dict(),
                    vocabulary=vocabulary, updates=updates, epoch=epoch, partitions=partitions,
                    fixed_partitions=fixed_partitions, perspective_hashes=perspective_hashes,
                    python_rng=generator.getstate(), torch_rng=torch.get_rng_state(), source_hashes=dict(inputs),
                    horizon_seconds=args.horizon_seconds, native_actor_connected=False, model_contract=model_contract())

            def save_checkpoint(snapshot, checkpoint, aliases):
                check()
                unchanged()
                buffer = io.BytesIO()
                torch.save(checkpoint, buffer)
                data = buffer.getvalue()
                with snapshot.open("xb") as stream:
                    stream.write(data)
                for alias in aliases:
                    pending = alias.with_suffix(".pending")
                    with pending.open("xb") as stream:
                        stream.write(data)
                    pending.replace(alias)
                return bytes_sha(data)
            result = dict(
                training_replays=len(train),
                validation_replays=len(valid),
                vocabulary_tokens=len(vocabulary),
                updates=updates,
                passes=[],
                initial_validation=evaluate(
                    model, valid, vocabulary, horizon=args.horizon_seconds, check=check
                ),
            )
            status["races"][race] = result
            epoch_offset = parent["epoch"] if parent else 0
            initial = output / f"{race}-initial.pt"
            initial_sha = save_checkpoint(initial, checkpoint_value(epoch_offset),
                [output / f"{race}-best.pt", output / f"{race}-last.pt"])
            result.update(best_epoch=0, best_validation=result["initial_validation"],
                          best_checkpoint_sha256=initial_sha, last_checkpoint_sha256=initial_sha,
                          initial_checkpoint_sha256=initial_sha)
            best = result["initial_validation"]["known_target_cross_entropy"]
            write_json(output / "status.json", status)
            for epoch in range(1, args.epochs + 1):
                check()
                unchanged()
                model.train()
                chosen = sample_pass(train, generator)
                examples = [
                    (r, i)
                    for r in chosen
                    for i, c in enumerate(r["commands"])
                    if c["game_loop"] <= args.horizon_seconds * 22.4
                ]
                generator.shuffle(examples)
                loss_sum = 0.0
                for start in range(0, len(examples), 128):
                    check()
                    chunk = examples[start : start + 128]
                    tokens, times, lengths, wanted, wait = collate_examples(
                        [prefix_example(r, i, vocabulary) for r, i in chunk]
                    )
                    logits, predicted_wait = model(tokens, times, lengths, len(vocabulary))
                    loss, _, _ = imitation_loss(logits, predicted_wait, wanted, wait)
                    optimizer.zero_grad(set_to_none=True)
                    loss.backward()
                    norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                    if not torch.isfinite(loss) or not torch.isfinite(norm):
                        raise ValueError("Nonfinite gradient/loss")
                    optimizer.step()
                    updates += 1
                    loss_sum += float(loss.detach()) * len(chunk)
                validation = evaluate(model, valid, vocabulary, horizon=args.horizon_seconds, check=check)
                score = validation["known_target_cross_entropy"]
                record = dict(
                    epoch=epoch,
                    updates=updates,
                    cumulative_epoch=epoch_offset + epoch,
                    sampled_perspectives=[[r["replay_id"], r["player_id"]] for r in chosen],
                    events=len(examples),
                    training_loss=loss_sum / max(1, len(examples)),
                    validation=validation,
                )
                result["passes"].append(record)
                result["updates"] = updates
                verify_optimizer(model, optimizer, updates)
                checkpoint = checkpoint_value(epoch_offset + epoch)
                snapshot = output / f"{race}-epoch{epoch:03d}.pt"
                aliases = [output / f"{race}-last.pt"]
                if score < best:
                    aliases.append(output / f"{race}-best.pt")
                result["last_checkpoint_sha256"] = save_checkpoint(snapshot, checkpoint, aliases)
                if score < best:
                    best = score
                    result["best_epoch"] = epoch
                    result["best_validation"] = validation
                    result["best_checkpoint_sha256"] = sha(output / f"{race}-best.pt")
                unchanged()
                write_json(output / "status.json", status)
                print(
                    json.dumps(
                        {
                            "race": race,
                            "epoch": epoch,
                            "updates": updates,
                            "validation_accuracy": validation["accuracy"],
                            "validation_ce": score,
                        }
                    ),
                    flush=True,
                )
        status["status"] = "complete"
    except (TimeoutError, InterruptedError) as exc:
        status.update(status="stopped_at_bound", reason=str(exc))
    except Exception as exc:
        status.update(status="failed", error=repr(exc))
        raise
    finally:
        unchanged()
        status.update(
            finished_at=datetime.now(timezone.utc).isoformat(),
            wall_seconds=time.monotonic() - started,
            process_active=False,
        )
        write_json(output / "status.json", status)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--wall-seconds", type=int, default=900)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--horizon-seconds", type=int, default=480)
    run(parser.parse_args())
