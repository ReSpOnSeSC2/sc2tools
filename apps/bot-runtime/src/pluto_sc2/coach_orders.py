"""Strict, local JSON strategy orders for an isolated coached experiment.

Orders contain bounded objectives, never executable code, raw unit tags or
arbitrary commands. The executor must still derive its current legal actions
from the permitted observation and honor every ordinary input restriction.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import time
from types import MappingProxyType
from typing import Any, Mapping

from .schema import BUILD_TYPES, RESEARCH_UPGRADES, TRAIN_TYPES


MAX_ORDER_BYTES = 64 * 1024
MAX_HORIZON_SECONDS = 600.0
STANCES = frozenset(("defend", "pressure", "attack", "retreat"))
PRODUCTION_TYPES = frozenset(BUILD_TYPES) - {"NEXUS", "PYLON", "ASSIMILATOR"}
COMPOSITION_TYPES = frozenset(TRAIN_TYPES) - {"PROBE"}


def _integer(name: str, value: Any, low: int, high: int | None = None) -> int:
    if type(value) is not int or value < low or (high is not None and value > high):
        raise ValueError(f"{name} must be an integer in {low}..{high if high is not None else 'unbounded'}")
    return value


def _seconds(name: str, value: Any) -> float:
    if type(value) not in (int, float):
        raise ValueError(f"{name} must be a finite nonnegative number")
    try:
        result = float(value)
    except OverflowError as error:
        raise ValueError(f"{name} must be finite") from error
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be a finite nonnegative number")
    return result


def _targets(name: str, values: Any, allowed: frozenset[str], maximum: int) -> dict[str, int]:
    if not isinstance(values, dict):
        raise ValueError(f"{name} must be a JSON object")
    result = {}
    for key, value in values.items():
        if type(key) is not str or key not in allowed:
            raise ValueError(f"{name} contains an unsupported unit or building")
        result[key] = _integer(f"{name}.{key}", value, 0, maximum)
    return result


@dataclass(frozen=True)
class StrategyOrder:
    schema: int
    game_id: str
    revision: int
    based_on_report: int
    issued_game_seconds: float
    valid_until_game_seconds: float
    stance: str
    scout: bool
    worker_target: int
    base_target: int
    gas_workers_per_base: int
    production_targets: Mapping[str, int]
    composition: Mapping[str, int]
    research: tuple[str, ...]
    rationale: str

    def __post_init__(self) -> None:
        if type(self.schema) is not int or self.schema != 1:
            raise ValueError("strategy schema must be integer 1")
        if type(self.game_id) is not str or not self.game_id.strip() or len(self.game_id) > 128:
            raise ValueError("game_id must be a nonempty string of at most 128 characters")
        _integer("revision", self.revision, 1)
        _integer("based_on_report", self.based_on_report, 0)
        issued = _seconds("issued_game_seconds", self.issued_game_seconds)
        expires = _seconds("valid_until_game_seconds", self.valid_until_game_seconds)
        if not 0 < expires - issued <= MAX_HORIZON_SECONDS:
            raise ValueError("strategy validity horizon must be greater than zero and at most 600 seconds")
        if type(self.stance) is not str or self.stance not in STANCES:
            raise ValueError("unsupported stance")
        if type(self.scout) is not bool:
            raise ValueError("scout must be boolean")
        _integer("worker_target", self.worker_target, 8, 80)
        _integer("base_target", self.base_target, 1, 8)
        _integer("gas_workers_per_base", self.gas_workers_per_base, 0, 6)
        production = _targets("production_targets", self.production_targets, PRODUCTION_TYPES, 12)
        composition = _targets("composition", self.composition, COMPOSITION_TYPES, 100)
        if not any(composition.values()):
            raise ValueError("composition must include at least one positive target")
        if (not isinstance(self.research, (list, tuple))
                or any(type(upgrade) is not str or upgrade not in RESEARCH_UPGRADES for upgrade in self.research)
                or len(set(self.research)) != len(self.research)):
            raise ValueError("research must contain unique allowed upgrade names")
        if type(self.rationale) is not str or len(self.rationale) > 2000:
            raise ValueError("rationale must be a string of at most 2000 characters")
        object.__setattr__(self, "issued_game_seconds", issued)
        object.__setattr__(self, "valid_until_game_seconds", expires)
        object.__setattr__(self, "production_targets", MappingProxyType(production))
        object.__setattr__(self, "composition", MappingProxyType(composition))
        object.__setattr__(self, "research", tuple(self.research))

    @classmethod
    def from_dict(cls, data: Any) -> StrategyOrder:
        expected = {field.name for field in fields(cls)}
        if not isinstance(data, dict) or any(type(key) is not str for key in data):
            raise ValueError("strategy must be a JSON object with string keys")
        if set(data) != expected:
            raise ValueError(f"strategy fields mismatch: missing={sorted(expected - set(data))}, "
                             f"unknown={sorted(set(data) - expected)}")
        if not isinstance(data["research"], list):
            raise ValueError("JSON research field must be a list")
        return cls(**data)

    def to_dict(self) -> dict:
        result = {field.name: getattr(self, field.name) for field in fields(self)}
        result["production_targets"] = dict(self.production_targets)
        result["composition"] = dict(self.composition)
        result["research"] = list(self.research)
        return result


def write_strategy(path: str | Path, order: StrategyOrder | dict) -> None:
    """Atomically replace one strategy JSON file after validating its schema."""
    order = order if isinstance(order, StrategyOrder) else StrategyOrder.from_dict(order)
    serialized = json.dumps(order.to_dict(), indent=2, allow_nan=False, ensure_ascii=False) + "\n"
    if len(serialized.encode("utf-8")) > MAX_ORDER_BYTES:
        raise ValueError("serialized strategy exceeds 64 KB")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".strategy-",
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        # The executor reads this file during play. A short-lived Windows read
        # handle must not lose a strategist update or require a partial write.
        for attempt in range(21):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 20:
                    raise
                time.sleep(.025 if attempt < 4 else .05)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _nonfinite_json(_value: str) -> None:
    raise ValueError("nonfinite JSON number")


class CoachMailbox:
    """Read local strategy.json per decision; preserve a valid current order.

    Invalid or partial replacement files do not replace the accepted order.
    The accepted order still expires according to game time. Audit files are
    create-only and deduplicated by bounded content fingerprint and outcome.
    """

    def __init__(self, directory: str | Path, game_id: str):
        if type(game_id) is not str or not game_id.strip() or len(game_id) > 128:
            raise ValueError("game_id must be a nonempty string of at most 128 characters")
        self.directory = Path(directory).resolve()
        self.game_id = game_id
        self.path = self.directory / "strategy.json"
        self.audit_directory = self.directory / "coach-order-audit"
        self._current: StrategyOrder | None = None
        self._accepted_digest: str | None = None
        self._audited: set[tuple[str, str]] = set()
        self._status = {"game_id": game_id, "last_status": "uninitialized", "diagnostic": None,
                        "accepted_revision": 0, "active_revision": None, "last_digest": None,
                        "accepted_orders": 0, "rejected_contents": 0,
                        "strategy_file": str(self.path), "audit_directory": str(self.audit_directory)}

    @property
    def status(self) -> dict:
        return dict(self._status)

    def _active(self, now: float, report_sequence: int) -> StrategyOrder | None:
        order = self._current
        if (order is not None and order.issued_game_seconds <= now < order.valid_until_game_seconds
                and order.based_on_report <= report_sequence):
            self._status["active_revision"] = order.revision
            return order
        self._status["active_revision"] = None
        return None

    def _audit(self, digest: str, outcome: str, now: float, report_sequence: int,
               diagnostic: str | None, order: StrategyOrder | None, *, digest_kind: str) -> None:
        key = (digest, outcome)
        if key in self._audited:
            return
        self.audit_directory.mkdir(parents=True, exist_ok=True)
        game_digest = hashlib.sha256(self.game_id.encode("utf-8")).hexdigest()[:16]
        path = self.audit_directory / f"{game_digest}-{digest}-{outcome}.json"
        record = {"schema": 1, "game_id": self.game_id, "outcome": outcome,
                  "game_seconds": now, "report_sequence": report_sequence,
                  "recorded_at": datetime.now(timezone.utc).isoformat(), "digest": digest,
                  "digest_kind": digest_kind, "diagnostic": diagnostic,
                  "order": order.to_dict() if order is not None else None}
        try:
            with path.open("x", encoding="utf-8") as stream:
                json.dump(record, stream, indent=2, allow_nan=False, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            pass  # Never rewrite earlier audit evidence, even after a restart.
        self._audited.add(key)
        if outcome == "rejected":
            self._status["rejected_contents"] += 1

    def poll(self, now: float, report_sequence: int) -> StrategyOrder | None:
        now = _seconds("now", now)
        report_sequence = _integer("report_sequence", report_sequence, 0)
        digest = None
        digest_kind = "sha256"
        order = None
        try:
            with self.path.open("rb") as stream:
                before = os.fstat(stream.fileno())
                raw = stream.read(MAX_ORDER_BYTES)
                after = os.fstat(stream.fileno())
            if before.st_size > MAX_ORDER_BYTES:
                digest_kind = "sha256_first_64KB_and_file_size"
                digest = hashlib.sha256(raw + str(before.st_size).encode("ascii")).hexdigest()
                raise ValueError("strategy file exceeds 64 KB")
            digest = hashlib.sha256(raw).hexdigest()
            if (before.st_size != len(raw) or after.st_size != before.st_size
                    or after.st_mtime_ns != before.st_mtime_ns):
                raise ValueError("strategy file changed while being read")
            if digest == self._accepted_digest:
                active = self._active(now, report_sequence)
                self._status.update(last_status="active" if active is not None else "expired",
                                    diagnostic=None if active is not None else "accepted strategy is no longer active",
                                    last_digest=digest)
                return active
            data = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_nonfinite_json)
            order = StrategyOrder.from_dict(data)
            if order.game_id != self.game_id:
                raise ValueError("strategy belongs to a different game")
            if order.revision <= self._status["accepted_revision"]:
                raise ValueError("strategy revision is stale or already accepted")
            if order.based_on_report > report_sequence:
                raise ValueError("strategy is based on a future report")
            if order.issued_game_seconds > now:
                raise ValueError("strategy has a future issue time")
            if now >= order.valid_until_game_seconds:
                raise ValueError("strategy has expired")
            self._audit(digest, "accepted", now, report_sequence, None, order, digest_kind=digest_kind)
            self._current = order
            self._accepted_digest = digest
            self._status.update(last_status="accepted", diagnostic=None, last_digest=digest,
                                accepted_revision=order.revision, accepted_orders=self._status["accepted_orders"] + 1)
        except FileNotFoundError:
            self._status.update(last_status="missing", diagnostic="strategy.json is not available", last_digest=None)
        except (OSError, ValueError, UnicodeDecodeError, RecursionError) as error:
            diagnostic = f"{type(error).__name__}: {error}"
            self._status.update(last_status="rejected", diagnostic=diagnostic, last_digest=digest)
            if digest is not None:
                try:
                    self._audit(digest, "rejected", now, report_sequence, diagnostic, order, digest_kind=digest_kind)
                except OSError as audit_error:
                    self._status["diagnostic"] += f"; audit unavailable: {audit_error}"
        return self._active(now, report_sequence)
