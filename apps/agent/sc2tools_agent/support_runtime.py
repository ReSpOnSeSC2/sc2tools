"""One admitted support worker and private monotonic review leases.

Locks protect metadata only. Every provider/probe/IO/publication callback runs
outside controller/state locks, with current checks on both sides. Public
results carry a nonce, never a credential-bearing scope or callback.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import platform
import re
import threading
import time

from . import __version__
from .state import _STATE_SAVE_LOCK, credential_scope, credential_status
from .sync_retry import replay_ticket
from .support_diagnostics import (
    CHECK_CODES, ERROR_CODES, ROW_IDS, DiagnosticRow, DiagnosticSnapshot, collect_diagnostics,
    primitive_dict,
)
from .support_export import build_export_plan
from .support_files import SupportFileError, probe_storage, read_log_selections, write_reviewed_bundle
from .support_probes import FolderRoots, FolderSummary, ProbeResult, folders_probe, http_probe, obs_probe, sync_probe
from .support_fixture import run_fixture
from .support_redaction import RESULT_CODES

CHECK_SECONDS = 45.0
SERVICE_CODES = frozenset(("ok", "unavailable", "busy", "cancelled", "unsafe_path", "file_changed", "already_exists", "write_failed", "invalid_plan"))


@dataclass(frozen=True, slots=True)
class PreviewEntry:
    alias: str
    size: int
    sha256: str
    omitted_lines: int
    truncated: bool
    redaction_code: str

    def __post_init__(self):
        if (type(self.alias) is not str or re.fullmatch(r"(?:diagnostics\.txt|state-summary\.json|logs/(?:agent-[0-2]|worker-[0-7])\.log)", self.alias) is None
            or type(self.size) is not int or not 0 <= self.size <= 512 * 1024
            or type(self.sha256) is not str or re.fullmatch(r"[0-9a-f]{64}", self.sha256) is None
            or type(self.omitted_lines) is not int or not 0 <= self.omitted_lines <= 512 * 1024 + 1
            or type(self.truncated) is not bool or type(self.redaction_code) is not str or self.redaction_code not in RESULT_CODES):
            raise ValueError("invalid_preview_entry")


@dataclass(frozen=True, slots=True)
class SupportResult:
    run_nonce: int
    kind: str
    snapshot: DiagnosticSnapshot | None = None
    folders: tuple = ()
    entries: tuple[PreviewEntry, ...] = ()
    code: str = "ok"

    def __post_init__(self):
        if (type(self.run_nonce) is not int or self.run_nonce <= 0 or type(self.kind) is not str
            or self.kind not in ("check", "copy", "review", "saved") or type(self.code) is not str or self.code not in SERVICE_CODES
            or self.snapshot is not None and type(self.snapshot) is not DiagnosticSnapshot
            or type(self.folders) is not tuple or len(self.folders) > 16 or any(type(item) is not FolderSummary for item in self.folders)
            or type(self.entries) is not tuple or len(self.entries) > 13 or any(type(item) is not PreviewEntry for item in self.entries)):
            raise ValueError("invalid_support_result")


class _Scope:
    # Default object repr deliberately does not expose any private field.
    def __init__(self, ticket, api, socket, binding, fingerprint, copied, obs, services, obs_status):
        self.ticket, self.api, self.socket, self.binding = ticket, api, socket, binding
        self.fingerprint, self.copied, self.obs = fingerprint, copied, obs
        self.services = services
        self.obs_status = obs_status

    def same(self, other):
        return (self.ticket.owner == other.ticket.owner and self.ticket.token == other.ticket.token
            and self.ticket.epoch is other.ticket.epoch and self.api is other.api and self.socket is other.socket
            and self.fingerprint == other.fingerprint and self.obs == other.obs
            and all(left is right for left, right in zip(self.services, other.services))
            and (self.binding is None and other.binding is None or self.binding is not None and other.binding is not None
                and self.binding[0] is other.binding[0] and self.binding[1] is other.binding[1]
                and self.binding[2:] == other.binding[2:]))


class SupportService:
    def __init__(self, *, cfg, state, cell, stop_event, log_dir, discover_folders,
                 obs_connection, clock=time.monotonic, worker_factory=threading.Thread):
        self.cfg, self.state, self.cell, self.stop_event = cfg, state, cell, stop_event
        self.log_dir, self.discover_folders, self.obs_connection = log_dir, discover_folders, obs_connection
        self.clock, self.worker_factory = clock, worker_factory
        self._lock = threading.Lock()
        self._nonce, self._busy, self._closed = 0, None, False
        self._scope, self._worker, self._review, self._snapshot = None, None, None, None
        self._settled = None
        self._history = deque(maxlen=10)

    def _capture(self):
        with _STATE_SAVE_LOCK:
            ticket = replay_ticket(self.state)
            api, socket = self.cell.api, self.cell.socket_client
            copied = {"version": __version__, "api_url": self.cfg.api_base, "workers": self.cfg.parse_concurrency,
                "sync_filter": self.state.sync_filter_preset or "all", "sync_since": self.state.sync_filter_since,
                "sync_until": self.state.sync_filter_until, "user_id": ticket.owner}
            fingerprint = (self.cfg.api_base, self.cfg.state_dir, self.cfg.parse_concurrency,
                self.state.api_base_override, self.state.parse_concurrency_override,
                self.state.sync_filter_preset, self.state.sync_filter_since, self.state.sync_filter_until,
                tuple(self.state.replay_folders_override[:128]), tuple(self.state.replay_folders_excluded[:128]),
                self.state.obs_scene_switch_enabled, self.cell.no_obs,
                getattr(api, "base_url", None), getattr(api, "device_token", None), credential_scope(self.state))
            services = self.cell.upload, self.cell.watcher, self.cell.ui
            obs_status = credential_status(self.state, "obs")
        # These may consult external metadata/env; never hold either lock here.
        binding = socket.support_scope(ticket.token) if socket is not None else None
        obs = self.obs_connection()
        return _Scope(ticket, api, socket, binding, fingerprint, copied, obs, services, obs_status)

    def _scope_current(self, scope):
        if self.stop_event.is_set():
            return False
        try:
            return scope.same(self._capture())
        except Exception:
            return False

    def is_current(self, run_nonce):
        """The queued Qt/clipboard/save receiver accepts only this public nonce."""
        with self._lock:
            scope = self._scope if type(run_nonce) is int and self._nonce == run_nonce and not self._closed else None
        if scope is None or not self._scope_current(scope):
            return False
        with self._lock:
            return not self._closed and self._scope is scope and self._nonce == run_nonce

    @property
    def busy(self):
        with self._lock:
            return self._busy is not None

    def cancel(self):
        with self._lock:
            self._cancel_locked()
        # The actual worker slot deliberately remains occupied until finally.

    def _cancel_locked(self):
        self._nonce += 1
        self._scope, self._review, self._snapshot = None, None, None
        self._history.clear()

    def invalidate_for_epoch(self, expected_epoch):
        with self._lock:
            # Admission is locked; a newer owner cannot install a review here
            # while this scalar lifetime check invalidates the older review.
            if expected_epoch is None or getattr(self.state, "_owner_epoch", None) is not expected_epoch:
                return False
            self._cancel_locked()
            return True

    invalidate = cancel

    def close(self):
        self.cancel()
        with self._lock:
            self._closed = True
            worker = self._worker
            settled = self._settled
        if settled is not None and worker is not threading.current_thread():
            settled.wait()  # Includes admission that has not reached Thread.start yet.

    def _admit(self, kind, on_result, *, reviewed_nonce=None, destination=None):
        try:
            scope = self._capture()
        except Exception:
            return None
        if not self._scope_current(scope):
            return None
        settled, started = threading.Event(), threading.Event()
        with self._lock:
            if self._closed or self._busy is not None:
                return None
            if reviewed_nonce is not None:
                if self._review is None or self._review[0] != reviewed_nonce or self._nonce != reviewed_nonce:
                    return None
                old_scope, plan = self._review[1:]
                if not old_scope.same(scope):
                    return None
                nonce = reviewed_nonce
            else:
                self._nonce += 1
                nonce, plan = self._nonce, None
                self._review = None
            self._scope = scope
            reservation = object()
            self._busy = reservation
            self._settled = settled

        def work():
            started.set()
            try:
                if not self.is_current(nonce):
                    return
                result = self._perform(kind, nonce, scope, plan, destination)
                if result is not None and self.is_current(nonce):
                    on_result(result)
            except Exception as exc:
                if self.is_current(nonce):
                    try:
                        code = exc.code if isinstance(exc, SupportFileError) and exc.code in SERVICE_CODES else "unavailable"
                        on_result(SupportResult(nonce, kind, code=code))
                    except Exception:
                        pass
            finally:
                with self._lock:
                    if self._busy is reservation:
                        self._busy, self._worker = None, None
                        self._settled = None
                settled.set()

        try:
            worker = self.worker_factory(target=work, name="sc2tools-support", daemon=True)
            with self._lock:
                self._worker = worker
            worker.start()
        except Exception:
            if not started.is_set() and ("worker" not in locals() or worker.ident is None):
                with self._lock:
                    if self._busy is reservation:
                        self._busy, self._worker, self._settled = None, None, None
                settled.set()  # Proven not started; otherwise retain real admission.
            return None
        return nonce

    def run_check(self, on_result):
        return self._admit("check", on_result)

    def copy_info(self, on_result):
        return self._admit("copy", on_result)

    def prepare_bundle(self, on_result):
        return self._admit("review", on_result)

    def save_reviewed(self, run_nonce, destination, on_result):
        if not self.is_current(run_nonce):
            return None
        return self._admit("saved", on_result, reviewed_nonce=run_nonce, destination=destination)

    def _read_support(self, scope, current):
        def read(callback):
            if not current():
                raise RuntimeError()
            value = callback()
            if not current():
                raise RuntimeError()
            return value
        raw = dict(scope.copied)
        system = platform.system()
        raw["os_name"] = "macOS" if system == "Darwin" else system
        match = re.match(r"[0-9]+(?:\.[0-9]+){0,3}", platform.version())
        if match is None:
            match = re.match(r"[0-9]+(?:\.[0-9]+){0,3}", platform.release())
        raw["os_version"] = match.group() if match else None
        updater, watcher, ui, queue = self.cell.updater, self.cell.watcher, self.cell.ui, self.cell.upload
        raw["channel"] = getattr(updater, "_channel", "stable")
        processes = getattr(watcher, "_uses_processes", None)
        raw["pool_mode"] = "process" if processes is True else "thread" if processes is False else None
        discovered = read(self.discover_folders)
        roots_complete = discovered.complete if type(discovered) is FolderRoots else True
        automatic_available = discovered.automatic_available if type(discovered) is FolderRoots else True
        discovered = discovered.paths if type(discovered) is FolderRoots else discovered
        discovered = discovered if type(discovered) in (list, tuple) else ()
        raw["folder_count"] = len(discovered) if roots_complete else None
        raw["_roots_complete"] = roots_complete
        raw["_roots_automatic_available"] = automatic_available
        folders = tuple(discovered[:17])
        raw["regions"] = tuple(sorted({{"1": "us", "2": "eu", "3": "kr", "5": "cn"}.get(toon.split("-", 1)[0])
            for toon in scope.ticket.toons or () if type(toon) is str} - {None})) if scope.ticket.toons else None
        raw["pending"] = read(queue.pending_count) if queue is not None else None
        raw["archive_pending"] = read(queue.archive_pending_count) if queue is not None else None
        raw["paused"] = read(queue.is_paused) if queue is not None else None
        facts = read(ui.health.facts) if ui is not None else None
        if self.cell.live_metrics_logger is not None:
            raw["live_metrics"] = read(self.cell.live_metrics_logger._metrics.snapshot)
        with self._lock:
            raw["errors"] = [code for owner, epoch, api, code in self._history
                if owner == scope.ticket.owner and epoch is scope.ticket.epoch and api is scope.api]
        return raw, facts, folders

    def capture_error(self, api):
        """Capture at request admission, never label an old failure on receipt."""
        try:
            scope = self._capture()
            if scope.api is not api or not self._scope_current(scope):
                return lambda _code: None
        except Exception:
            return lambda _code: None
        return lambda code: self._record_error(scope, code)

    def _record_error(self, scope, code):
        if type(code) is not str or code not in ERROR_CODES or not self._scope_current(scope):
            return
        with _STATE_SAVE_LOCK:
            if not scope.ticket.current(self.state) or self.cell.api is not scope.api:
                return
            with self._lock:
                if not self._closed:
                    self._history.append((scope.ticket.owner, scope.ticket.epoch, scope.api, code))

    def record_upload_error(self, context, code):
        # Queue context was captured at admission; no current-owner stamping.
        try:
            scope = self._capture()
            if (context.api is scope.api and context.owner == scope.ticket.owner and context.token == scope.ticket.token
                and context.owner_epoch is scope.ticket.epoch):
                self._record_error(scope, code)
        except Exception:
            pass

    def _perform(self, kind, nonce, scope, reviewed_plan, destination):
        current = lambda: self.is_current(nonce)
        cancelled = lambda: not current()
        if kind == "saved":
            if not current():
                return None
            write_reviewed_bundle(reviewed_plan, destination, is_current=current, is_cancelled=cancelled)
            return SupportResult(nonce, kind) if current() else None
        raw, facts, roots = self._read_support(scope, current)
        checks, folders = {}, ()
        with self._lock:
            previous = self._snapshot
        if kind != "check" and previous is not None and previous[0].same(scope):
            checks = {row.id: {"status": row.status, "code": row.code, "action": row.action,
                "count": row.count, "latency_ms": row.latency_ms} for row in previous[1].rows}
            folders = previous[2]
        deadline = self.clock() + CHECK_SECONDS
        if kind == "check":
            for row_id in ROW_IDS:
                if not current():
                    return None
                limit = min(deadline, self.clock() + (20 if row_id == "analyzer" else 4))
                result = self._probe(row_id, scope, facts, roots, raw, current, cancelled, limit)
                if not current():
                    return None
                row = result.row
                checks[row_id] = {"status": row.status, "code": row.code, "action": row.action,
                    "count": row.count, "latency_ms": row.latency_ms}
                folders = result.folders or folders
                if row.code in ERROR_CODES:
                    self._record_error(scope, row.code)
        bound_api = (scope.api is not None and getattr(scope.api, "device_token", None) == scope.ticket.token
            and getattr(scope.api, "base_url", None) == self.cfg.api_base)
        device = lambda: scope.socket.support_device_id(scope.ticket.token, scope.binding) if scope.socket is not None and bound_api else None
        snapshot = collect_diagnostics(lambda: raw, lambda: checks, is_current=current, is_cancelled=cancelled, validate_device=device)
        if snapshot is None or not current():
            return None
        if kind == "review":
            selections = read_log_selections(self.log_dir, sensitive_values=tuple(value for value in
                (scope.ticket.token, scope.ticket.owner, scope.obs[2]) if type(value) is str and value),
                is_current=current, is_cancelled=cancelled)
            if not current():
                return None
            plan = build_export_plan(snapshot, selections, is_current=current, is_cancelled=cancelled)
            if plan is None or not current():
                return None
            with self._lock:
                if self._nonce != nonce:
                    return None
                self._review = nonce, scope, plan
            entries = tuple(PreviewEntry(item.alias, item.size, item.sha256, item.omitted_lines,
                item.truncated, item.redaction_code) for item in plan.entries)
            return SupportResult(nonce, kind, snapshot, folders, entries)
        with self._lock:
            if self._nonce == nonce and kind == "check":
                self._snapshot = scope, snapshot, folders
        return SupportResult(nonce, kind, snapshot, folders)

    def _probe(self, row_id, scope, facts, roots, raw, current, cancelled, deadline):
        try:
            if row_id == "storage":
                result = primitive_dict(probe_storage(self.cfg.state_dir, is_current=current, is_cancelled=cancelled))
                code = result.get("code") if result.get("code") in CHECK_CODES else "unavailable"
                return ProbeResult(DiagnosticRow(row_id, result.get("status", "unavailable"), code, "open_settings", result.get("count")))
            if row_id == "folders":
                return folders_probe(roots, is_current=current, is_cancelled=cancelled, deadline=deadline, clock=self.clock,
                    roots_complete=raw.get("_roots_complete") is True,
                    automatic_available=raw.get("_roots_automatic_available") is True)
            if row_id == "analyzer":
                result = run_fixture(is_current=current, is_cancelled=cancelled, deadline=deadline, clock=self.clock)
                return ProbeResult(DiagnosticRow(row_id, result["status"], result["code"], "retry", latency_ms=result.get("latency_ms")))
            if row_id in ("version", "api", "profile", "client_api"):
                if row_id == "profile" and (scope.api is None or getattr(scope.api, "device_token", None) != scope.ticket.token
                    or getattr(scope.api, "base_url", None) != self.cfg.api_base):
                    return ProbeResult(DiagnosticRow(row_id))
                return http_probe(row_id, "http://localhost:6119" if row_id == "client_api" else self.cfg.api_base,
                    token=scope.ticket.token if row_id == "profile" else None, version=__version__, channel=raw["channel"],
                    is_current=current, is_cancelled=cancelled, deadline=deadline, clock=self.clock)
            if row_id == "obs":
                enabled = self.state.obs_scene_switch_enabled is True and not self.cell.no_obs
                if enabled and scope.obs_status not in ("available", "cleared", "missing") and not scope.obs[2]:
                    return ProbeResult(DiagnosticRow("obs", "unavailable", "unavailable", "open_settings"))
                return obs_probe(enabled, scope.obs, is_current=current, is_cancelled=cancelled, deadline=deadline, clock=self.clock)
            return sync_probe(facts, raw.get("pending"))
        except Exception:
            return ProbeResult(DiagnosticRow(row_id))
