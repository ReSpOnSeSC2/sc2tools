"""Bounded selected-log reads and exact reviewed-byte support archives.

Windows is the shipping filesystem boundary. Other platforms fail closed;
pure diagnostic projection and preview remain usable there. No raw state,
recursive state-directory walks or arbitrary user-selected inputs are read.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import secrets
import shutil
import zipfile

from .support_diagnostics import active
from .support_export import ExportPlan, LogSelection, MAX_PLAN_BYTES
from .support_redaction import MAX_RAW_BYTES, redact_log

MAX_DIRECTORY_ENTRIES = 4096
_WORKER = re.compile(r"agent-worker-[1-9][0-9]{0,9}\.log(?:\.[1-9][0-9]?)?")
_CODES = frozenset(("cancelled", "unsafe_path", "unavailable", "file_changed",
    "already_exists", "write_failed", "invalid_plan"))


class SupportFileError(Exception):
    def __init__(self, code):
        self.code = code if type(code) is str and code in _CODES else "unavailable"
        super().__init__(self.code)


def _checkpoint(is_current, is_cancelled):
    if not active(is_current, is_cancelled):
        raise SupportFileError("cancelled")


def _windows():
    from .support_files_windows import WindowsFiles
    return WindowsFiles()


def _translate(exc, *, writing=False):
    if isinstance(exc, SupportFileError):
        return exc
    if isinstance(exc, ValueError):
        return SupportFileError("unsafe_path")
    if getattr(exc, "winerror", None) in (80, 183) or isinstance(exc, FileExistsError):
        return SupportFileError("already_exists")
    return SupportFileError("write_failed" if writing else "unavailable")


def _read_tail(files, path, *, is_current, is_cancelled):
    # Sharing permits the active logger's append handle. Identity/size/time
    # checks reject observable changes and delete sharing blocks rotation.
    # Windows can defer timestamps of an open writer: this is a bounded byte
    # capture, not a claim of an atomic snapshot against same-size overwrites.
    # Every captured byte still goes through the closed redaction projection.
    _checkpoint(is_current, is_cancelled)
    with files.open_read(path) as source:
        before = source.verify(path)
        start = max(0, before["size"] - MAX_RAW_BYTES)
        source.seek(start)
        data = bytearray()
        remaining = before["size"] - start
        while remaining:
            _checkpoint(is_current, is_cancelled)
            chunk = source.read(min(64 * 1024, remaining))
            _checkpoint(is_current, is_cancelled)
            if not chunk:
                raise SupportFileError("file_changed")
            data.extend(chunk)
            remaining -= len(chunk)
        after = source.verify(path)
        if any(before[key] != after[key] for key in ("identity", "size", "modified", "links")):
            raise SupportFileError("file_changed")
        _checkpoint(is_current, is_cancelled)
        return bytes(data), start > 0


def read_log_selections(log_dir, *, sensitive_values=(), is_current, is_cancelled):
    """Snapshot at most3 parent/8 worker logs, with generated archive names."""
    _checkpoint(is_current, is_cancelled)
    try:
        files = _windows()
        selections = []
        with files.hold_directory(log_dir) as root:
            workers = []
            seen = 0
            # Only this known log directory, never recursion or state.json.
            with os.scandir(root) as entries:
                for entry in entries:
                    _checkpoint(is_current, is_cancelled)
                    seen += 1
                    if seen > MAX_DIRECTORY_ENTRIES:
                        raise SupportFileError("unavailable")
                    if _WORKER.fullmatch(entry.name):
                        stat = entry.stat(follow_symlinks=False)
                        workers.append((stat.st_mtime_ns, entry.name))
                        workers.sort(reverse=True)
                        del workers[8:]
            selected = [("parent", i, root / ("agent.log" + (f".{i}" if i else ""))) for i in range(3)]
            selected.extend(("worker", i, root / name) for i, (_at, name) in enumerate(workers))
            for kind, slot, path in selected:
                _checkpoint(is_current, is_cancelled)
                try:
                    data, partial_start = _read_tail(files, path, is_current=is_current, is_cancelled=is_cancelled)
                except FileNotFoundError:
                    # An absent log contributes no source or invented content.
                    continue
                document = redact_log((data,), sensitive_values=sensitive_values, starts_mid_line=partial_start)
                _checkpoint(is_current, is_cancelled)
                selections.append(LogSelection(kind, slot, document))
            _checkpoint(is_current, is_cancelled)
        return tuple(selections)
    except Exception as exc:
        raise _translate(exc) from None


def _discard(handle):
    try:
        handle.discard()
    except Exception:
        # A failed exact-handle deletion is reported; never fall back to a path.
        raise SupportFileError("write_failed") from None


def write_reviewed_bundle(plan, destination, *, is_current, is_cancelled):
    """Create a new archive exclusively, then rename the same owned handle.

    Existing destinations are never replaced. On cancellation/failure, only
    the exact new temporary/archive handle is marked for deletion.
    """
    _checkpoint(is_current, is_cancelled)
    try:
        if type(plan) is not ExportPlan:
            raise ValueError("invalid_plan")
        plan.__post_init__()
    except Exception:
        raise SupportFileError("invalid_plan") from None
    handle = None
    complete = False
    try:
        from .support_files_windows import local_path
        destination = local_path(destination)
        if destination.suffix.lower() != ".zip":
            raise SupportFileError("unsafe_path")
        files = _windows()
        with files.hold_directory(destination.parent) as parent:
            _checkpoint(is_current, is_cancelled)
            temporary = parent / (".sc2tools-support-" + secrets.token_hex(16) + ".tmp")
            handle = files.create_new(temporary)
            with zipfile.ZipFile(handle, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for entry in plan.entries:
                    _checkpoint(is_current, is_cancelled)
                    info = zipfile.ZipInfo(entry.alias, (1980, 1, 1, 0, 0, 0))
                    info.create_system = 0
                    info.external_attr = 0x20
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, entry.data, compresslevel=6)
                    _checkpoint(is_current, is_cancelled)
            handle.flush()
            info = handle.verify(temporary)
            if info["size"] > MAX_PLAN_BYTES + 128 * 1024:
                raise SupportFileError("write_failed")
            _checkpoint(is_current, is_cancelled)
            handle.rename_new(destination)
            handle.verify(destination)
            _checkpoint(is_current, is_cancelled)
        _checkpoint(is_current, is_cancelled)
        complete = True
    except Exception as exc:
        raise _translate(exc, writing=True) from None
    finally:
        if handle is not None:
            try:
                try:
                    if not complete:
                        _discard(handle)
                finally:
                    handle.close()
            except Exception:
                raise SupportFileError("write_failed") from None


def probe_storage(state_dir, *, is_current, is_cancelled):
    """Create/discard one new owned file; never read or rewrite agent state."""
    _checkpoint(is_current, is_cancelled)
    handle = None
    try:
        files = _windows()
        with files.hold_directory(state_dir) as root:
            _checkpoint(is_current, is_cancelled)
            temporary = root / (".sc2tools-support-probe-" + secrets.token_hex(16) + ".tmp")
            handle = files.create_new(temporary)
            handle.write(b"support storage check\n")
            handle.flush()
            handle.verify(temporary)
            _checkpoint(is_current, is_cancelled)
            free_mib = shutil.disk_usage(root).free // (1024 * 1024)
            _checkpoint(is_current, is_cancelled)
            return {"status": "pass", "code": "ok", "action": "none",
                "count": free_mib if 0 <= free_mib <= 999_999_999 else None}
    except SupportFileError:
        raise
    except Exception:
        return {"status": "fail", "code": "not_writable", "action": "open_settings"}
    finally:
        if handle is not None:
            try:
                try:
                    _discard(handle)
                finally:
                    handle.close()
            except Exception:
                raise SupportFileError("write_failed") from None
