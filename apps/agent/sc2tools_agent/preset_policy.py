"""Bounded global-preset cache; no credentials or private build definitions.

Heartbeat refreshes the public manifest. Every parse process independently
reads the same atomic file, retaining its last compatible hash-verified value
through outages/corruption; a fresh install falls back to its released trees.
"""
from __future__ import annotations

import copy
import json
import logging
import threading
from collections import OrderedDict
from pathlib import Path

MAX_POLICY_BYTES = 1024 * 1024
CACHE_NAME = "preset-policy.json"
_cache = OrderedDict()
_lock = threading.Lock()


def load_cached_policy(state_dir: Path):
    from core.preset_policy import policy_snapshot, validate_policy
    path = state_dir / CACHE_NAME
    key = str(path.resolve())
    with _lock:
        prior = _cache.get(key)
        try:
            info = path.stat()
            stamp = (info.st_mtime_ns, info.st_size)
            if prior and prior[0] == stamp:
                return copy.deepcopy(prior[1])
            if info.st_size > MAX_POLICY_BYTES:
                raise ValueError("policy_too_large")
            with path.open("rb") as source:
                raw = source.read(MAX_POLICY_BYTES + 1)
            if len(raw) > MAX_POLICY_BYTES:
                raise ValueError("policy_too_large")
            value = validate_policy(json.loads(raw.decode("utf-8")))
            _cache[key] = (stamp, value)
            _cache.move_to_end(key)
            while len(_cache) > 4:
                _cache.popitem(last=False)
            return copy.deepcopy(value)
        except (OSError, ValueError, TypeError):
            return copy.deepcopy(prior[1]) if prior else policy_snapshot()


class PresetPolicyRefresh:
    def __init__(self, api, state_dir: Path):
        self.api = api
        self.state_dir = state_dir

    def refresh(self):
        """Only the existing minute heartbeat calls this; failure is advisory."""
        try:
            from .replay_pipeline import bootstrap_analyzer_path
            bootstrap_analyzer_path()
            from core.atomic_io import atomic_write_bytes
            from core.preset_policy import validate_policy
            value = validate_policy(self.api.get_preset_policy())
            wire = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(wire) > MAX_POLICY_BYTES:
                raise ValueError("policy_too_large")
            path = self.state_dir / CACHE_NAME
            try:
                with path.open("rb") as source:
                    unchanged = source.read(MAX_POLICY_BYTES + 1) == wire
            except OSError:
                unchanged = False
            if not unchanged:
                atomic_write_bytes(str(path), wire)
            return value["hash"]
        except Exception:  # An offline/older API must never mark pairing offline.
            logging.getLogger(__name__).debug("preset_policy_refresh_unavailable", exc_info=True)
            return None
