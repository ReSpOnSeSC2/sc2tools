"""Bounded, current heartbeat facts. Names never enter logs or public status."""
from collections import Counter, OrderedDict
from datetime import datetime, timezone
import json
import math
import re
import threading

SYNC_REPORT_MAX_BYTES = 2048
COUNT_MAX = 999_999
MAX_UNRESOLVED_PATHS = 2048
SKIP_REASONS = frozenset(("ai_game", "resumed_replay", "player_unresolved", "no_result",
    "parse_failed", "analysis_failed", "file_unstable", "playback_budget_exceeded", "unsupported_replay"))
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_TOON = re.compile(r"^[0-9]+-S2-[0-9]+-[0-9]+$")
_UNSAFE = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")


def report_size(report):
    # Bound requests' default encoder, including spaces and escaped Unicode.
    # The API's compact UTF-8 JSON is necessarily smaller than this bound.
    return len(json.dumps(report, ensure_ascii=True, allow_nan=False).encode("utf-8"))


def _count(value):
    return min(COUNT_MAX, max(0, int(value))) if isinstance(value, (int, float)) and math.isfinite(value) else 0


def _candidate(entry):
    if not isinstance(entry, (tuple, list)) or len(entry) != 2:
        return None
    name, handle = entry
    if not isinstance(name, str) or not isinstance(handle, str):
        return None
    name = name.strip()[:32]
    if not name or _UNSAFE.search(name) or len(handle) > 32 or not _TOON.fullmatch(handle):
        return None
    # The API cap counts UTF-16 units, including two units per astral character.
    while len(name.encode("utf-16-le")) > 64:
        name = name[:-1]
    return name, handle


class SyncReportTracker:
    """Runtime-only candidates by replay path; retries replace, never add counts.

    Every report intersects candidates with a locked copy of the current
    uploaded markers. A resync, success or filter change therefore retires
    names immediately, without guessing from lifetime history totals.
    """
    def __init__(self):
        self._lock = threading.RLock()
        self._unresolved = OrderedDict()
        self._generation = 0
        self._upload_error = ""
        self._transport_error = ""
        self._pending = 0

    def unresolved(self, path, entries):
        candidates = dict()
        for entry in entries or ():
            candidate = _candidate(entry)
            if candidate:
                name, handle = candidate
                candidates[handle] = name
            if len(candidates) >= 16:
                break
        with self._lock:
            self._generation += 1
            self._unresolved[str(path)] = (self._generation, tuple(candidates.items()))
            self._unresolved.move_to_end(str(path))
            while len(self._unresolved) > MAX_UNRESOLVED_PATHS:
                self._unresolved.popitem(last=False)

    def generation(self):
        with self._lock:
            return self._generation

    def upload_failed(self, code, *, transient=True):
        with self._lock:
            # Terminal callbacks can arrive after pending0. Their rejected
            # marker is already counted; they must not seed a future queue.
            if self._pending > 0 and transient:
                self._upload_error = code if isinstance(code, str) and _CODE.fullmatch(code) else "unknown"

    def upload_succeeded(self):
        with self._lock:
            self._upload_error = ""
            self._transport_error = ""

    def connection(self, kind):
        with self._lock:
            self._transport_error = "" if kind == "online" else kind if isinstance(kind, str) and _CODE.fullmatch(kind) else "unknown"

    def pending(self, count):
        with self._lock:
            self._pending = max(0, count)
            if self._pending == 0:
                self._upload_error = ""  # A drained queue retires its failing work.

    def report(self, facts, uploaded, *, generation=None):
        generation = self.generation() if generation is None else generation
        skipped, rejected, filtered = Counter(), 0, 0
        unresolved_paths = set()
        latest = facts.last_upload_at
        for path, marker in uploaded.items():
            if marker in ("filtered", "skipped:filtered"):
                filtered += 1
            elif marker == "rejected":
                rejected += 1
            elif isinstance(marker, str) and marker.startswith("skipped:"):
                reason = marker.split(":", 1)[1]
                if reason in SKIP_REASONS:
                    skipped[reason] += 1
                    if reason == "player_unresolved":
                        unresolved_paths.add(path)
        with self._lock:
            # A candidate captured after the caller copied markers may not
            # appear there yet. Retire only records older than that copy.
            for path, (observed, _) in list(self._unresolved.items()):
                if path not in unresolved_paths and observed <= generation:
                    del self._unresolved[path]
            counts, names = Counter(), {}
            for path in unresolved_paths:
                for handle, name in self._unresolved.get(path, (0, ()))[1]:
                    counts[handle] += 1
                    names[handle] = name
            error = self._upload_error or self._transport_error
        report = {"pending": _count(facts.pending), "archivePending": _count(facts.archive_pending),
            "paused": bool(facts.paused), "foldersWatched": _count(len(facts.folders or ())),
            "missingFolders": _count(len(facts.missing_folders)), "rejected": _count(rejected), "filtered": _count(filtered)}
        if skipped:
            report["skipped"] = {reason: _count(count) for reason, count in sorted(skipped.items())}
        if latest is not None and math.isfinite(latest) and 1262304000 <= latest <= datetime.now(timezone.utc).timestamp() + 86400:
            report["lastUploadAt"] = datetime.fromtimestamp(latest, timezone.utc).isoformat().replace("+00:00", "Z")
        if error and facts.pending > 0:
            report["lastErrorCode"] = error
        candidates = [{"name": names[handle], "toonHandle": handle, "count": _count(count)}
            for handle, count in sorted(counts.items(), key=lambda row: (-row[1], row[0])) if count >= 3][:10]
        if candidates:
            report["unresolvedNames"] = candidates
        # Names are optional diagnostics: trim those first, never current counts.
        while report_size(report) >= SYNC_REPORT_MAX_BYTES and report.get("unresolvedNames"):
            report["unresolvedNames"].pop()
        if not report.get("unresolvedNames"):
            report.pop("unresolvedNames", None)
        return report
