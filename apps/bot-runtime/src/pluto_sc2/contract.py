"""Compatibility contract shared by replay datasets and model checkpoints."""

from __future__ import annotations

import hashlib
import json

from pluto_sc2.fairplay import FAIRPLAY_VERSION, MAX_APM
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE, SCHEMA_VERSION

START_WORKERS = 8


def model_metadata(**extra) -> dict:
    result = {
        "race": "Protoss", "start_workers": START_WORKERS,
        "max_apm": MAX_APM, "fairplay_version": FAIRPLAY_VERSION, "step_mul": 8,
        "observation_schema": SCHEMA_VERSION, "observation_size": OBSERVATION_SIZE,
        "action_names": list(ACTION_NAMES),
        "action_hash": hashlib.sha256(json.dumps(list(ACTION_NAMES)).encode()).hexdigest(),
    }
    result.update(extra)
    return result


def validate_metadata(metadata: dict) -> None:
    for key, expected in model_metadata().items():
        if metadata.get(key) != expected:
            raise ValueError(f"Checkpoint contract mismatch for {key}: expected {expected!r}; "
                             f"got {metadata.get(key)!r}. Retrain or import a compatible checkpoint.")
