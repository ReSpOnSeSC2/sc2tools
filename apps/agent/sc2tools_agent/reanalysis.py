"""Managed re-analysis: re-parse games the cloud asks for with this engine.

The API sends batches of at most 100 game ids (``reanalyze:batch``) and
waits for this agent's acknowledgement and every game's outcome before it
sends the next batch. One worker thread handles one game at a time:

* the local replay from the ``path_by_game_id`` index when it still exists;
* otherwise the owner's archived original, fetched through a short-lived
  signed HTTPS URL from the API into an exclusive temp file (no redirects,
  5 MiB cap, connect/read/total time limits), checked against the archive's
  size and SHA-256, and deleted as soon as it has been parsed.

The parse must yield the expected game id. The result goes through the
normal upload queue, so parse-time provenance stamps and the API's ingest
admission gate apply. Each game ends with exactly one ``reanalyze:outcome``.
This never falls back to a full re-sync and never records SC2 playback.
Signed URLs, file paths and replay contents never reach logs or outcomes.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import hashlib
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
MAX_BATCH = 100
MAX_ORIGINAL_BYTES = 5 * 1024 * 1024
DOWNLOAD_TIMEOUT = (5.0, 30.0)
DOWNLOAD_TOTAL_SEC = 120.0
UPLOAD_SETTLE_SEC = 15 * 60
IDENTITY_WAIT_SEC = 30.0
IDLE_EXIT_SEC = 60.0
TEMP_PREFIX = "reanalyze-"
OUTCOMES = frozenset({"uploaded", "not_found", "download_failed", "invalid_original",
                      "game_mismatch", "parse_failed", "rejected", "upload_failed"})
_HEX24 = re.compile(r"[a-f0-9]{24}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_MPQ = (b"MPQ\x1b", b"MPQ\x1a")
_BATCH_KEYS = frozenset({"version", "jobId", "generation", "seq", "deviceId", "sessionId", "games"})


class ItemFailure(Exception):
    """A game's terminal outcome decided before upload."""

    def __init__(self, outcome: str):
        super().__init__(outcome)
        self.outcome = outcome


@dataclass
class _Batch:
    job_id: str
    seq: int
    generation: int
    token: str
    emit: Callable[[dict], None]
    pending: deque = field(default_factory=deque)
    settled: dict = field(default_factory=dict)
    active: Optional[str] = None
    cancelled: bool = False


def _positive_int(value: Any) -> bool:
    return type(value) is int and 0 < value < 2 ** 53


def _game_id(value: Any) -> bool:
    return (isinstance(value, str) and 0 < len(value) <= 200 and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _original(value: Any):
    if value is None:
        return None, True
    if (not isinstance(value, dict) or set(value) != {"sizeBytes", "sha256"}
            or type(value["sizeBytes"]) is not int or not 4 <= value["sizeBytes"] <= MAX_ORIGINAL_BYTES
            or not isinstance(value["sha256"], str) or not _SHA256.fullmatch(value["sha256"])):
        return None, False
    return {"sizeBytes": value["sizeBytes"], "sha256": value["sha256"]}, True


def parse_batch(raw: Any):
    """Strict ``reanalyze:batch`` payload, or None."""
    if (not isinstance(raw, dict) or set(raw) != _BATCH_KEYS or raw["version"] != PROTOCOL_VERSION
            or type(raw["version"]) is not int
            or not isinstance(raw["jobId"], str) or not _HEX24.fullmatch(raw["jobId"])
            or not _positive_int(raw["generation"]) or not _positive_int(raw["seq"])
            or not isinstance(raw["deviceId"], str) or not _HEX24.fullmatch(raw["deviceId"])
            or not isinstance(raw["sessionId"], str) or not 0 < len(raw["sessionId"]) <= 200
            or not isinstance(raw["games"], list) or not 0 < len(raw["games"]) <= MAX_BATCH):
        return None
    games, seen = [], set()
    for entry in raw["games"]:
        if not isinstance(entry, dict) or set(entry) != {"gameId", "original"} or not _game_id(entry["gameId"]):
            return None
        original, ok = _original(entry["original"])
        if not ok or entry["gameId"] in seen:
            return None
        seen.add(entry["gameId"])
        games.append((entry["gameId"], original))
    return raw["jobId"], raw["seq"], raw["generation"], games


def ack(raw: Any, code: str, outcomes=()) -> dict:
    """Echo only validated identifiers; never reflect unchecked fields."""
    echo = raw if isinstance(raw, dict) else {}
    job_id, seq, generation = echo.get("jobId"), echo.get("seq"), echo.get("generation")
    reply = {"jobId": job_id if isinstance(job_id, str) and _HEX24.fullmatch(job_id) else None,
             "seq": seq if _positive_int(seq) else None,
             "generation": generation if _positive_int(generation) else None,
             "code": code}
    if outcomes:
        reply["outcomes"] = [dict(outcome) for outcome in outcomes]
    return reply


def _unlink(path: Optional[Path]) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.warning("reanalysis_temp_cleanup_failed")


def purge_stale_temp(directory: Path) -> None:
    """Remove originals a previous run left behind (only this module's files)."""
    try:
        for leftover in directory.glob(TEMP_PREFIX + "*.SC2Replay"):
            _unlink(leftover)
    except OSError:
        pass


def stream_original(url: str, out, original, *, get=None, clock=time.monotonic) -> None:
    """Copy one signed object into ``out`` within the size/time bounds."""
    import requests
    get = get or requests.get
    deadline = clock() + DOWNLOAD_TOTAL_SEC
    digest, total, head = hashlib.sha256(), 0, b""
    try:
        with get(url, stream=True, allow_redirects=False, timeout=DOWNLOAD_TIMEOUT,
                 headers={"user-agent": "sc2tools-agent"}) as response:
            if response.status_code != 200:
                raise ItemFailure("download_failed")
            length = response.headers.get("content-length")
            if length is not None and (not str(length).isdigit() or int(length) > MAX_ORIGINAL_BYTES):
                raise ItemFailure("invalid_original")
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_ORIGINAL_BYTES:
                    raise ItemFailure("invalid_original")
                if clock() > deadline:
                    raise ItemFailure("download_failed")
                if len(head) < 4:
                    head += chunk[:4 - len(head)]
                digest.update(chunk)
                out.write(chunk)
    except ItemFailure:
        raise
    except Exception:  # noqa: BLE001 - transport errors carry the signed URL
        raise ItemFailure("download_failed") from None
    if head not in _MPQ:
        raise ItemFailure("invalid_original")
    if original is not None and (total != original["sizeBytes"] or digest.hexdigest() != original["sha256"]):
        raise ItemFailure("invalid_original")


def fetch_original(api_base: str, token: str, game_id: str, original, directory: Path, *, get=None) -> Path:
    """Download the archived original into a new exclusive temp file."""
    from .api_client import ApiClient
    try:
        info = ApiClient(base_url=api_base, device_token=token).get_replay_download(game_id)
    except Exception:  # noqa: BLE001
        raise ItemFailure("download_failed") from None
    if info is None:
        raise ItemFailure("not_found")
    url = info.get("url") if isinstance(info, dict) else None
    if not isinstance(url, str) or len(url) > 8192:
        raise ItemFailure("download_failed")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ItemFailure("download_failed")
    directory.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".SC2Replay", dir=str(directory))
    path, complete = Path(name), False
    try:
        with os.fdopen(handle, "wb") as out:
            stream_original(url, out, original, get=get)
        complete = True
        return path
    finally:
        if not complete:
            _unlink(path)


def parse_replay(path: Path, ticket, state_dir):
    """Parse with the bundled engine; returns a ParsedGame or None."""
    from .replay_pipeline import parse_replay_for_cloud_ex
    from .watcher import _parse_with_candidates
    parsed, _reason, _candidates = _parse_with_candidates(
        parse_replay_for_cloud_ex, path, owned_toons=ticket.toons, owned_hint=ticket.hint,
        state_dir=state_dir, resolve_pulse=False,
    )
    return parsed


class ReanalysisController:
    """One worker, one game at a time, for the current ``reanalyze:batch``."""

    def __init__(self, *, cfg, state, cell, stop_event, parse=parse_replay, fetch=fetch_original,
                 clock=time.monotonic, settle_seconds: float = UPLOAD_SETTLE_SEC,
                 identity_wait: float = IDENTITY_WAIT_SEC):
        self.cfg, self.state, self.cell, self.stop_event = cfg, state, cell, stop_event
        self._parse, self._fetch, self._clock = parse, fetch, clock
        self._settle_seconds, self._identity_wait = settle_seconds, identity_wait
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._batch: Optional[_Batch] = None
        self._thread: Optional[threading.Thread] = None
        base = Path(cfg.state_dir) if getattr(cfg, "state_dir", None) else Path(tempfile.gettempdir()) / "sc2tools"
        self.temp_dir = base / "reanalysis-tmp"
        purge_stale_temp(self.temp_dir)

    # ---------------- socket entry points ----------------
    def handle_batch(self, raw, token, emit) -> dict:
        parsed = parse_batch(raw)
        if parsed is None:
            return ack(raw, "invalid_request")
        if not isinstance(token, str) or not token or self.stop_event.is_set():
            return ack(raw, "local_error")
        job_id, seq, generation, games = parsed
        with self._lock:
            batch = self._batch
            if batch is not None and batch.job_id == job_id and batch.seq == seq:
                # A redelivery (reconnect, resume): continue the same work and
                # report what this batch already settled.
                batch.generation, batch.token, batch.emit, batch.cancelled = generation, token, emit, False
                queued = {game_id for game_id, _original in batch.pending}
                for game_id, original in games:
                    if game_id not in batch.settled and game_id not in queued and game_id != batch.active:
                        batch.pending.append((game_id, original))
                outcomes = [batch.settled[game_id] for game_id, _original in games if game_id in batch.settled]
            else:
                # The API moved on (next batch, another job): it is authoritative.
                self._batch = _Batch(job_id, seq, generation, token, emit, deque(games))
                outcomes = []
            self._ensure_worker()
        self._wake.set()
        return ack(raw, "accepted", outcomes)

    def handle_cancel(self, raw) -> None:
        if not isinstance(raw, dict) or not isinstance(raw.get("jobId"), str):
            return
        with self._lock:
            batch = self._batch
            if batch is not None and batch.job_id == raw["jobId"]:
                batch.cancelled = True
                batch.pending.clear()

    # ---------------- worker ----------------
    def _ensure_worker(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="sc2tools-reanalysis", daemon=True)
            self._thread.start()

    def _next(self):
        with self._lock:
            batch = self._batch
            if batch is None or batch.cancelled or not batch.pending:
                return None
            game_id, original = batch.pending.popleft()
            batch.active = game_id
            return batch, game_id, original

    def _held(self) -> bool:
        queue = getattr(self.cell, "upload", None)
        held = getattr(queue, "history_held", None)
        try:
            return bool(held()) if callable(held) else False
        except Exception:  # noqa: BLE001
            return False

    def _run(self) -> None:
        idle_since = self._clock()
        while not self.stop_event.is_set():
            if self._held():
                # Paused syncing or a match in progress: start nothing new,
                # like the watcher's own history work.
                self._wake.wait(2.0)
                self._wake.clear()
                idle_since = self._clock()
                continue
            item = self._next()
            if item is None:
                self._wake.wait(1.0)
                self._wake.clear()
                with self._lock:
                    if self._clock() - idle_since >= IDLE_EXIT_SEC and (self._batch is None or not self._batch.pending):
                        self._thread = None
                        return
                continue
            batch, game_id, original = item
            try:
                outcome, engine = self._process(batch, game_id, original)
            finally:
                with self._lock:
                    if batch.active == game_id:
                        batch.active = None
            if outcome is not None:
                self._report(batch, game_id, outcome, engine)
            idle_since = self._clock()

    def _ticket(self):
        from .sync_retry import replay_ticket
        ticket = replay_ticket(self.state)
        deadline = self._clock() + self._identity_wait
        while ticket.toons == () and self._clock() < deadline and not self.stop_event.is_set():
            self.stop_event.wait(1.0)
            ticket = replay_ticket(self.state)
        return ticket

    def _local_path(self, game_id: str) -> Optional[Path]:
        from .state import _STATE_SAVE_LOCK
        with _STATE_SAVE_LOCK:
            index = getattr(self.state, "path_by_game_id", None) or {}
            raw = index.get(game_id) if isinstance(index, dict) else None
        if not isinstance(raw, str) or not raw:
            return None
        path = Path(raw)
        try:
            return path if path.suffix.lower() == ".sc2replay" and path.is_file() else None
        except OSError:
            return None

    def _process(self, batch: _Batch, game_id: str, original):
        ticket = self._ticket()
        temp: Optional[Path] = None
        try:
            path = self._local_path(game_id)
            if path is None:
                if original is None:
                    return "not_found", None
                temp = self._fetch(self.cfg.api_base, batch.token, game_id, original, self.temp_dir)
                path = temp
            try:
                parsed = self._parse(path, ticket, getattr(self.cfg, "state_dir", None))
            finally:
                # Everything the upload needs is in memory now.
                _unlink(temp)
            game = getattr(parsed, "game", None)
            if game is None:
                return "parse_failed", None
            if getattr(game, "game_id", None) != game_id:
                return "game_mismatch", None
            if getattr(game, "is_resumed_from_replay", False) is True:
                return "parse_failed", None
            if not ticket.current(self.state):
                self.handle_cancel({"jobId": batch.job_id})  # The agent's owner changed.
                return None, None
            engine = getattr(getattr(parsed, "provenance", None), "engine_version", None)
            return self._upload(path, parsed, transient=temp is not None), engine
        except ItemFailure as failure:
            return failure.outcome, None
        except Exception:  # noqa: BLE001 - one bad replay never stops the batch
            log.warning("reanalysis_item_failed", exc_info=True)
            return "parse_failed", None
        finally:
            _unlink(temp)

    def _upload(self, path: Path, parsed, *, transient: bool):
        from .uploader.queue import ReanalysisUpload, UploadJob
        queue = getattr(self.cell, "upload", None)
        if queue is None:
            return "upload_failed"
        done, result = threading.Event(), {}

        def settle(outcome: str) -> None:
            result.setdefault("outcome", outcome)
            done.set()

        job = UploadJob(file_path=path, game=parsed.game, priority=False, provenance=parsed.provenance,
                        reanalysis=ReanalysisUpload(transient=transient, settle=settle))
        if not queue.submit(job):
            return "upload_failed"
        deadline = self._clock() + self._settle_seconds
        while not done.wait(0.5):
            if self.stop_event.is_set():
                return None  # Shutting down: the API redelivers unsettled games later.
            if not queue.is_pending(path):
                done.wait(2.0)  # A settle callback runs just after the reservation ends.
                break
            if self._held():
                deadline = self._clock() + self._settle_seconds  # Expected holds never count.
            elif self._clock() >= deadline:
                break
        return result.get("outcome", "upload_failed")

    def _report(self, batch: _Batch, game_id: str, outcome: str, engine) -> None:
        body = {"gameId": game_id, "outcome": outcome}
        if isinstance(engine, str) and engine:
            body["engineVersion"] = engine
        with self._lock:
            batch.settled[game_id] = body
            payload = {"version": PROTOCOL_VERSION, "jobId": batch.job_id, "seq": batch.seq,
                       "generation": batch.generation, **body}
            emit = batch.emit
        try:
            emit(payload)
        except Exception:  # noqa: BLE001 - redelivery recovers the outcome
            log.debug("reanalysis_outcome_emit_failed")
