"""Read-only label compatibility audit for new observation-only eligibility.

No graph, optimizer, game, replay recapture, input mutation or model promotion.
Masks are constructed from the frame before independently checking expert labels.
Any rejected teacher action is recorded, never used to loosen its mask.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys
import time
import traceback

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from scripts.fit_alphastar_balanced import RunGuard  # noqa: E402
from scripts.infer_alphastar_checkpoint import read_checkpoint_artifacts  # noqa: E402
from scripts.preflight_alphastar_curriculum import identity, label_fingerprint, observation_fingerprint  # noqa: E402
from scripts.train_alphastar_replay import TensorError, read_dataset, sha256, train_rows  # noqa: E402
from pluto_sc2.action_eligibility_v1 import build_action_eligibility  # noqa: E402
from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample  # noqa: E402

PREFERRED_SHA = "a8dfbec8d7a6189c97fa5af304287bf1fa917bae5ed004d442da7685925efaa6"


def rejected_arguments(eligibility, prediction, registry, *, max_entities):
    function = int(prediction["function"])
    if not 0 <= function < len(registry):
        raise TensorError("Function outside pinned registry")
    reasons = []
    if not eligibility["function_mask"][function]:
        reasons.append("function_ineligible")
    if "unit_tags" in registry[function]["args"]:
        for raw_index in prediction["unit_tags"]:
            index = int(raw_index)
            if index == max_entities:
                break  # Supplemental mask does not govern recurrent EOS semantics.
            if not 0 <= index < max_entities:
                raise TensorError("Source outside pinned pointer vocabulary")
            if not eligibility["source_masks"][function][index]:
                reasons.append(f"source_{index}_ineligible")
    return reasons


def run(args):
    output, origin, dataset = map(lambda value: Path(value).resolve(),
                                   (args.output, args.run, args.dataset))
    if output.exists():
        raise TensorError("Audit output must be new")
    guard = RunGuard(args.wall_seconds, [ROOT / "STOP", output / "STOP", origin / "STOP", dataset / "STOP"])
    guard.check("eligibility CPU audit")
    artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
    if artifacts["checkpoint_sha256"] != PREFERRED_SHA or artifacts["result"]["optimizer_updates"] != 6089:
        raise TensorError("This version audits only the exact6089 preferred checkpoint")
    manifest, catalog, hashes, counts = read_dataset(dataset)
    if hashes != artifacts["result"]["dataset_hashes"] or dict(counts) != {"train": 1217}:
        raise TensorError("Immutable full-game dataset differs")
    config, registry = artifacts["config"], artifacts["registry"]
    wanted = {tuple(row) for row in artifacts["result"]["admitted_identities"]}
    if len(wanted) != 1201 or len(manifest["replay_partitions"]) != 1:
        raise TensorError("Expected exact single-replay1201 diagnostic admissions")
    predictions = {identity(event): event for event in artifacts["result"]["evaluations"][-1]["greedy"]["events"]}
    if set(predictions) != wanted:
        raise TensorError("Stored inference identities differ")
    sources = [Path(__file__), ROOT / "src/pluto_sc2/action_eligibility_v1.py",
               ROOT / "src/pluto_sc2/policy_intents.py", ROOT / "src/pluto_sc2/rich_actions.py",
               ROOT / "src/pluto_sc2/rich_intents.py", ROOT / "scripts/fit_alphastar_balanced.py",
               ROOT / "src/pluto_sc2/alphastar_tensor.py", ROOT / "scripts/infer_alphastar_checkpoint.py",
               ROOT / "scripts/train_alphastar_replay.py", ROOT / "scripts/preflight_alphastar_curriculum.py",
               origin / "result.json", origin / "registry.json", origin / "checkpoint.msgpack",
               dataset / "manifest.json", dataset / "samples.jsonl.gz", dataset / "game-data.json"]
    source_hashes = {str(path): sha256(path) for path in sources}
    output.mkdir(parents=True, exist_ok=False)
    records, rejected, predicted_rejected = [], [], []
    reason_counts, function_counts = Counter(), Counter()
    for sample in train_rows(dataset):
        row_id = identity(sample)
        if row_id not in wanted:
            continue
        guard.check("eligibility sample")
        observation = tensorize_observation(sample["frame"], registry, artifacts["unit_types"], config)
        # This call cannot receive intent, label, action ordinal, or prediction.
        eligibility = build_action_eligibility(sample["frame"], observation["metadata"]["entity_tags"],
                                               registry, catalog, max_entities=config.max_entities)
        function_mask = np.asarray(eligibility["function_mask"])
        source_masks = np.asarray(eligibility["source_masks"])
        if (function_mask.shape != (len(registry),) or source_masks.shape != (len(registry), config.max_entities)
                or function_mask.dtype != np.bool_ or source_masks.dtype != np.bool_):
            raise TensorError("Supplemental mask shape/dtype mismatch")
        teacher = tensorize_sample(sample, registry, artifacts["unit_types"], config)
        teacher_observation = {"metadata": {}, "inputs": {key: value for key, value in teacher["inputs"].items()
                                         if key == "step_type" or isinstance(key, tuple) and key[0] == "observation"}}
        if observation_fingerprint(observation) != observation_fingerprint(teacher_observation):
            raise TensorError("Expert label construction changed observation")
        teacher_reasons = rejected_arguments(eligibility, teacher["labels"], registry, max_entities=config.max_entities)
        prediction_reasons = rejected_arguments(eligibility, predictions[row_id]["prediction"], registry,
                                                max_entities=config.max_entities)
        teacher_function = int(teacher["labels"]["function"])
        record = {"identity": list(row_id), "observation_sha256": observation_fingerprint(observation),
                  "label_sha256": label_fingerprint(teacher), "function": registry[teacher_function]["name"],
                  "teacher_rejected": teacher_reasons, "saved_prediction_rejected": prediction_reasons,
                  "functions_disabled": int(np.sum(~function_mask)),
                  "actual_source_entries_disabled": int(np.sum(~source_masks[:, :len(eligibility['entity_tags'])])),
                  "ui_negative_evidence": eligibility["ui_negative_evidence"],
                  "rules_sha256": eligibility["rules_sha256"]}
        records.append(record)
        if teacher_reasons:
            diagnostics = next((row for row in eligibility["reviewed_functions"] if row["id"] == teacher_function), None)
            rejected.append({**record, "rule_evidence": diagnostics})
            reason_counts.update(teacher_reasons)
        if prediction_reasons:
            predicted_rejected.append({"identity": list(row_id), "function": predictions[row_id]["function"],
                                       "reasons": prediction_reasons})
            function_counts.update([predictions[row_id]["function"]])
    if {tuple(row["identity"]) for row in records} != wanted:
        raise TensorError("Incomplete or duplicated original admissions")
    guard.check("final eligibility audit")
    if any(sha256(path) != checksum for path, checksum in source_hashes.items()):
        raise TensorError("Source or immutable input changed during audit")
    report = {
        "schema": "action-eligibility1201-cpu-preflight-v1",
        "status": "label_contract_passed" if not rejected else "label_conflicts_require_review",
        "completed_unix": time.time(), "checkpoint_sha256": artifacts["checkpoint_sha256"],
        "rows_checked": len(records), "teacher_labels_rejected": len(rejected),
        "teacher_rejection_reasons": dict(reason_counts), "quarantine_candidates": rejected,
        "existing_predictions_ineligible": len(predicted_rejected),
        "ineligible_prediction_functions": dict(function_counts),
        "ineligible_predictions": predicted_rejected, "records": records,
        "source_and_input_hashes": source_hashes, "source_inputs_unchanged": True,
        "existing_masks_relaxed": False, "original_admission_set_changed": False,
        "optimizer_updates": 0, "checkpoint_writes": 0, "model_forward_executed": False,
        "game_launches": 0, "eligible_for_training": False, "model_promoted": False,
        "scope": "Additional observation-only mask compatibility; actual graph and execution remain unverified",
    }
    (output / "preflight.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in (
        "status", "rows_checked", "teacher_labels_rejected", "existing_predictions_ineligible",
        "ineligible_prediction_functions", "eligible_for_training")}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--wall-seconds", type=float, default=600)
    args = parser.parse_args()
    existed = args.output.exists()
    try:
        run(args)
    except BaseException as error:
        if not existed and args.output.is_dir():
            (args.output / "failure.json").write_text(json.dumps({
                "status": "failed", "error": f"{type(error).__name__}: {error}",
                "traceback": traceback.format_exc(), "optimizer_updates": 0,
                "checkpoint_writes": 0, "game_launches": 0}, indent=2) + "\n", encoding="utf-8")
        raise


if __name__ == "__main__":
    main()
