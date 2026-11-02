"""Freeze exactly the reviewed safe bytes. No file reads, ZIPs or destinations.

The later writer must recheck its external monotonic owner/run guard before
saving. This plan deliberately carries no owner ticket or credential callback.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re

from .support_diagnostics import (
    DiagnosticSnapshot, MAX_DOCUMENT_BYTES, SCHEMA_VERSION, active,
    approved_document, diagnostic_bytes, state_summary_bytes,
)
from .support_redaction import MAX_LOG_BYTES, RESULT_CODES, RedactedLog

MAX_PARENT_LOGS = 3
MAX_WORKER_LOGS = 8
MAX_ENTRIES = 13
MAX_PLAN_BYTES = 8 * 1024 * 1024
_LOG_ALIAS = re.compile(r"logs/(?:agent-[0-2]|worker-[0-7])\.log")


def _alias(name):
    return type(name) is str and (name in ("diagnostics.txt", "state-summary.json") or _LOG_ALIAS.fullmatch(name) is not None)


@dataclass(frozen=True, slots=True)
class LogSelection:
    """Selection is a generated slot, never a source file name or path."""
    kind: str
    slot: int
    document: RedactedLog

    def __post_init__(self):
        if (type(self.kind) is not str or self.kind not in ("parent", "worker") or type(self.slot) is not int
            or not 0 <= self.slot < (MAX_PARENT_LOGS if self.kind == "parent" else MAX_WORKER_LOGS)
            or type(self.document) is not RedactedLog):
            raise ValueError("invalid_log_selection")
        self.document.__post_init__()


@dataclass(frozen=True, slots=True)
class ReviewedEntry:
    alias: str
    data: bytes
    size: int
    sha256: str
    omitted_lines: int = 0
    truncated: bool = False
    redaction_code: str = "ok"

    def __post_init__(self):
        if not _alias(self.alias) or type(self.data) not in (bytes, bytearray):
            raise ValueError("invalid_reviewed_entry")
        limit = MAX_LOG_BYTES if self.alias.startswith("logs/") else MAX_DOCUMENT_BYTES
        frozen = bytes(self.data[:limit + 1]) if type(self.data) is bytearray else self.data
        if len(frozen) > limit:
            raise ValueError("entry_too_large")
        object.__setattr__(self, "data", frozen)
        if (type(self.size) is not int or self.size != len(self.data) or type(self.sha256) is not str
            or self.sha256 != hashlib.sha256(self.data).hexdigest()
            or type(self.omitted_lines) is not int or not 0 <= self.omitted_lines <= 512 * 1024 + 1
            or type(self.truncated) is not bool or type(self.redaction_code) is not str or self.redaction_code not in RESULT_CODES):
            raise ValueError("invalid_reviewed_entry")
        try:
            self.data.decode("utf-8", errors="strict")
        except UnicodeError:
            raise ValueError("invalid_reviewed_entry") from None
        if self.alias.startswith("logs/"):
            RedactedLog(self.data, self.omitted_lines, self.truncated, self.redaction_code)
        elif (self.omitted_lines != 0 or self.truncated or self.redaction_code != "ok"
            or not approved_document(self.alias, self.data)):
            raise ValueError("invalid_reviewed_document")


def _entry(alias, data, omitted=0, truncated=False, code="ok"):
    frozen = bytes(data)
    return ReviewedEntry(alias, frozen, len(frozen), hashlib.sha256(frozen).hexdigest(), omitted, truncated, code)


def _manifest(entries):
    values = {"schema_version": SCHEMA_VERSION, "entries": [
        {"alias": entry.alias, "size": entry.size, "sha256": entry.sha256,
            "omitted_lines": entry.omitted_lines, "truncated": entry.truncated,
            "redaction_code": entry.redaction_code} for entry in entries],
        "total_bytes": sum(entry.size for entry in entries)}
    return (json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


@dataclass(frozen=True, slots=True)
class ExportPlan:
    entries: tuple[ReviewedEntry, ...]
    total_bytes: int
    manifest: bytes
    manifest_sha256: str
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if (type(self.entries) is not tuple or not 2 <= len(self.entries) <= MAX_ENTRIES
            or any(type(entry) is not ReviewedEntry for entry in self.entries)
            or type(self.schema_version) is not int or self.schema_version != SCHEMA_VERSION):
            raise ValueError("invalid_export_plan")
        for entry in self.entries:
            entry.__post_init__()
        aliases = tuple(entry.alias for entry in self.entries)
        if (aliases[:2] != ("diagnostics.txt", "state-summary.json") or len(set(aliases)) != len(aliases)
            or aliases[2:] != tuple(sorted(aliases[2:])) or any(not name.startswith("logs/") for name in aliases[2:])
            or type(self.total_bytes) is not int or self.total_bytes != sum(entry.size for entry in self.entries)
            or self.total_bytes > MAX_PLAN_BYTES or type(self.manifest) is not bytes
            or self.manifest != _manifest(self.entries) or type(self.manifest_sha256) is not str
            or self.manifest_sha256 != hashlib.sha256(self.manifest).hexdigest()):
            raise ValueError("invalid_export_plan")


def build_export_plan(snapshot, selections=(), *, is_current, is_cancelled):
    """Only projected diagnostics and redacted selected logs can enter a plan.

    Return None with no payload on any invalid selection, guard exception,
    cancellation, retirement or cap failure. Preview uses plan.entries directly.
    """
    if not active(is_current, is_cancelled):
        return None
    try:
        if type(snapshot) is not DiagnosticSnapshot or type(selections) not in (tuple, list):
            return None
        # Copy the selected container before constructing any reviewed bytes.
        selected = tuple(selections[:MAX_PARENT_LOGS + MAX_WORKER_LOGS + 1])
        if len(selected) > MAX_PARENT_LOGS + MAX_WORKER_LOGS:
            return None
        entries = [_entry("diagnostics.txt", diagnostic_bytes(snapshot)),
            _entry("state-summary.json", state_summary_bytes(snapshot.support))]
        logs = []
        for selection in selected:
            if not active(is_current, is_cancelled) or type(selection) is not LogSelection:
                return None
            selection.__post_init__()
            alias = f"logs/{'agent' if selection.kind == 'parent' else 'worker'}-{selection.slot}.log"
            document = selection.document
            logs.append(_entry(alias, document.data, document.omitted_lines, document.truncated, document.code))
        entries.extend(sorted(logs, key=lambda entry: entry.alias))
        frozen = tuple(entries)
        manifest = _manifest(frozen)
        if not active(is_current, is_cancelled):
            return None
        plan = ExportPlan(frozen, sum(entry.size for entry in frozen), manifest, hashlib.sha256(manifest).hexdigest())
    except Exception:
        return None
    return plan if active(is_current, is_cancelled) else None


def collect_export_plan(read_snapshot, read_selections, *, is_current, is_cancelled):
    """Guard both sides of callbacks; do not retain callbacks in reviewed values."""
    if not active(is_current, is_cancelled):
        return None
    try:
        snapshot = read_snapshot()
        if not active(is_current, is_cancelled):
            return None
        selections = read_selections()
        if not active(is_current, is_cancelled):
            return None
    except Exception:
        return None
    return build_export_plan(snapshot, selections, is_current=is_current, is_cancelled=is_cancelled)
