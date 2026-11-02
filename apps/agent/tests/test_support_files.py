"""Real Windows handle, link, race and exact-byte archive contracts."""
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import struct
import zipfile

import pytest

from sc2tools_agent import support_files as files
from sc2tools_agent import support_files_windows as windows_files
from sc2tools_agent.support_diagnostics import collect_diagnostics
from sc2tools_agent.support_export import build_export_plan
from sc2tools_agent.support_files_windows import Handle, WindowsFiles, local_path

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows filesystem boundary")


def current():
    return True


def cancelled():
    return False


def read_logs(root, **kwargs):
    return files.read_log_selections(root, is_current=kwargs.get("is_current", current),
        is_cancelled=kwargs.get("is_cancelled", cancelled), sensitive_values=kwargs.get("sensitive_values", ()))


def plan_for(root):
    snapshot = collect_diagnostics(lambda: {"version": "0.24.8", "user_id": "synthetic-owner"},
        lambda: {}, is_current=current, is_cancelled=cancelled)
    return build_export_plan(snapshot, read_logs(root), is_current=current, is_cancelled=cancelled)


def save(plan, destination, **kwargs):
    return files.write_reviewed_bundle(plan, destination,
        is_current=kwargs.get("is_current", current), is_cancelled=kwargs.get("is_cancelled", cancelled))


@pytest.mark.parametrize("path", ["relative.zip", r"C:relative.zip", r"\\server\share\bundle.zip",
    r"\\?\C:\bundle.zip", r"\\.\C:\bundle.zip", r"C:\folder\file.zip:secret",
    r"C:\folder\..\other\bundle.zip", "C:\\folder\\trailing \\bundle.zip",
    r"C:\folder\NUL.zip", r"C:\folder\CON.txt", "C:/folder/COM\u00b9.zip", "C:/folder/LPT\u00b3.zip",
    "C:\\folder\\\x00.zip"])
def test_path_aliases_are_rejected_before_open(path):
    with pytest.raises(ValueError, match="unsafe_path"):
        local_path(path)


def test_real_logs_are_bounded_redacted_generated_slots_without_state_recursion(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    for i in range(4):
        name = "agent.log" + (f".{i}" if i else "")
        (logs / name).write_bytes(b"event=health count=2\nTOKEN-SENTINEL player#1234 C:\\private\\x.SC2Replay\n")
    for i in range(12):
        (logs / f"agent-worker-{i + 1}.log").write_bytes(b"event=worker count=3\n")
    (tmp_path / "private-state.json").write_text('"TOKEN-SENTINEL"')
    nested = logs / "nested"
    nested.mkdir()
    (nested / "agent.log").write_text("NESTED-PRIVATE-SENTINEL")
    (logs / "unknown.log").write_text("UNKNOWN-PRIVATE-SENTINEL")
    selections = read_logs(logs, sensitive_values=("TOKEN-SENTINEL",))
    assert len(selections) == 11
    assert [(v.kind, v.slot) for v in selections[:3]] == [("parent", 0), ("parent", 1), ("parent", 2)]
    assert [(v.kind, v.slot) for v in selections[3:]] == [("worker", i) for i in range(8)]
    joined = b"".join(v.document.data for v in selections)
    assert b"event=health count=2\n" in joined
    assert all(secret not in joined for secret in (b"TOKEN-SENTINEL", b"player#1234", b"private", b"SC2Replay", b"NESTED", b"UNKNOWN"))
    assert all(v.document.omitted_lines == 1 for v in selections[:3])


def test_hardlinked_log_is_rejected_before_any_read(tmp_path, monkeypatch):
    logs = tmp_path / "logs"
    logs.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"event=health count=987654\n")
    os.link(outside, logs / "agent.log")
    reads = []
    original = Handle.read
    def counted(self, size=-1):
        reads.append(size)
        return original(self, size)
    monkeypatch.setattr(Handle, "read", counted)
    with pytest.raises(files.SupportFileError) as error:
        read_logs(logs)
    assert error.value.code == "unsafe_path"
    assert reads == []
    assert outside.read_bytes() == b"event=health count=987654\n"


def test_reparse_log_is_rejected_without_reading_target(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"event=health count=987654\n")
    try:
        (logs / "agent.log").symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"Synthetic symlink creation unavailable: {getattr(exc, 'winerror', None)}")
    with pytest.raises(files.SupportFileError) as error:
        read_logs(logs)
    assert error.value.code == "unsafe_path"


def test_real_junction_ancestor_is_rejected_without_reading_target(tmp_path, monkeypatch):
    """Mount-point reparses do not need the symlink-creation privilege."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "agent.log").write_bytes(b"event=health count=987654\n")
    junction = tmp_path / "linked-logs"
    junction.mkdir()
    backend = WindowsFiles()
    substitute = ("\\??\\" + str(outside)).encode("utf-16-le")
    printable = str(outside).encode("utf-16-le")
    names = substitute + b"\x00\x00" + printable + b"\x00\x00"
    data = struct.pack("<IHHHHHH", 0xA0000003, 8 + len(names), 0,
        0, len(substitute), len(substitute) + 2, len(printable)) + names
    operation = backend.kernel.DeviceIoControl
    operation.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    operation.restype = wintypes.BOOL
    buffer, returned = ctypes.create_string_buffer(data), wintypes.DWORD()
    try:
        with backend._open(junction, 0x40000000, 7, 3, directory=True) as handle:
            if not operation(handle.handle, 0x000900A4, buffer, len(data), None, 0, ctypes.byref(returned), None):
                raise ctypes.WinError(ctypes.get_last_error())
        reads = []
        original = Handle.read
        def counted(self, size=-1):
            reads.append(size)
            return original(self, size)
        monkeypatch.setattr(Handle, "read", counted)
        with pytest.raises(files.SupportFileError) as error:
            read_logs(junction)
        assert error.value.code == "unsafe_path"
        assert reads == []
        assert (outside / "agent.log").read_bytes() == b"event=health count=987654\n"
    finally:
        # rmdir removes only this exact synthetic directory/junction entry.
        junction.rmdir()


def test_held_ancestor_cannot_be_renamed_and_closes_after_use(tmp_path):
    root = tmp_path / "parent" / "logs"
    root.mkdir(parents=True)
    with WindowsFiles().hold_directory(root):
        with pytest.raises(PermissionError):
            root.parent.rename(tmp_path / "moved")
    root.parent.rename(tmp_path / "moved")
    assert (tmp_path / "moved" / "logs").is_dir()


def test_selected_directory_itself_cannot_be_renamed_until_handle_closes(tmp_path):
    root, moved = tmp_path / "selected", tmp_path / "moved"
    root.mkdir()
    assert root.resolve().is_relative_to(tmp_path.resolve()) and moved.resolve().is_relative_to(tmp_path.resolve())
    with WindowsFiles().hold_directory(root):
        with pytest.raises(PermissionError):
            root.rename(moved)
        assert root.is_dir() and not moved.exists()
    root.rename(moved)
    assert moved.is_dir() and not root.exists()


def test_same_handle_rename_rejects_another_parent_before_any_move(tmp_path):
    source, other = tmp_path / "source", tmp_path / "other"
    source.mkdir()
    other.mkdir()
    backend = WindowsFiles()
    with backend.hold_directory(source):
        handle = backend.create_new(source / "new.tmp")
        try:
            handle.write(b"synthetic reviewed bytes")
            with pytest.raises(ValueError, match="unsafe_path"):
                handle.rename_new(other / "support.zip")
            assert handle.final_path() == source / "new.tmp"
            assert list(other.iterdir()) == []
        finally:
            handle.discard()
            handle.close()
    assert list(source.iterdir()) == []


def test_pending_native_rename_waits_for_completion_before_releasing_status_buffer(tmp_path, monkeypatch):
    from types import SimpleNamespace
    calls, pending = [], []
    backend = WindowsFiles()
    handle = backend.create_new(tmp_path / "new.tmp")
    def native_rename(file, status, _buffer, _length, kind):
        calls.append("native")
        assert file == handle.handle and kind == 10
        pending.append(ctypes.cast(status, ctypes.POINTER(windows_files._IoStatus)))
        return 0x103
    def wait(file, timeout):
        calls.append("wait")
        assert file == handle.handle and timeout == 0xFFFFFFFF
        pending[0].contents.status = ctypes.c_long(0xC0000022).value
        return 0
    native = SimpleNamespace(NtSetInformationFile=native_rename, RtlNtStatusToDosError=lambda _status: 5)
    monkeypatch.setattr(windows_files, "_native", lambda: native)
    monkeypatch.setattr(backend.kernel, "WaitForSingleObject", wait)
    try:
        with pytest.raises(PermissionError):
            handle.rename_new(tmp_path / "support.zip")
        assert calls == ["native", "wait"]
        assert handle.final_path() == tmp_path / "new.tmp" and not (tmp_path / "support.zip").exists()
    finally:
        handle.discard()
        handle.close()
    assert list(tmp_path.iterdir()) == []


def test_in_place_growth_during_tail_read_discards_actual_result(tmp_path, monkeypatch):
    log = tmp_path / "agent.log"
    log.write_bytes(b"event=health count=1\n")
    original = Handle.read
    changed = []
    def append_after_read(self, size=-1):
        data = original(self, size)
        if not changed:
            changed.append(True)
            with log.open("ab") as destination:
                destination.write(b"event=health count=222\n")
        return data
    monkeypatch.setattr(Handle, "read", append_after_read)
    with pytest.raises(files.SupportFileError) as error:
        read_logs(tmp_path)
    assert error.value.code == "file_changed"
    assert changed == [True]


def test_real_tail_policy_never_reads_more_than_literal512k(tmp_path, monkeypatch):
    (tmp_path / "agent.log").write_bytes(b"event=health count=1\n" * 40_000)
    sizes = []
    original = Handle.read
    def counted(self, size=-1):
        result = original(self, size)
        sizes.append(len(result))
        return result
    monkeypatch.setattr(Handle, "read", counted)
    selections = read_logs(tmp_path)
    assert sum(sizes) == 512 * 1024
    assert max(sizes) <= 64 * 1024
    assert selections[0].document.truncated is True
    assert selections[0].document.omitted_lines >= 1
    assert len(selections[0].document.data) <= 512 * 1024


def test_reviewed_archive_contains_exact_frozen_bytes_no_extra_manifest(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "agent.log").write_bytes(b"event=health count=2\nSECRET-SENTINEL\n")
    plan = plan_for(logs)
    (logs / "agent.log").write_bytes(b"event=health count=999999\nCHANGED-SECRET\n")
    destination = tmp_path / "support.zip"
    save(plan, destination)
    with zipfile.ZipFile(destination) as archive:
        assert archive.namelist() == [entry.alias for entry in plan.entries]
        assert len(archive.namelist()) <= 13
        assert all(archive.read(entry.alias) == entry.data for entry in plan.entries)
        assert b"999999" not in archive.read("logs/agent-0.log")
        assert b"SECRET" not in b"".join(archive.read(name) for name in archive.namelist())
    assert list(tmp_path.glob(".sc2tools-support-*.tmp")) == []


def test_existing_destination_is_preserved_and_owned_temp_removed(tmp_path):
    destination = tmp_path / "support.zip"
    destination.write_bytes(b"existing synthetic file")
    with pytest.raises(files.SupportFileError):
        save(plan_for(tmp_path), destination)
    assert destination.read_bytes() == b"existing synthetic file"
    assert list(tmp_path.glob(".sc2tools-support-*.tmp")) == []


def test_explicit_flush_failure_before_publication_discards_owned_file(tmp_path, monkeypatch):
    plan = plan_for(tmp_path)
    def fail_flush(self):
        if self.handle is not None and self._writable:
            raise OSError("synthetic flush failure")
    monkeypatch.setattr(Handle, "flush", fail_flush)
    with pytest.raises(files.SupportFileError) as error:
        save(plan, tmp_path / "support.zip")
    assert error.value.code == "write_failed"
    assert list(tmp_path.iterdir()) == []


def test_close_does_not_issue_a_fallible_native_flush_after_rename(tmp_path, monkeypatch):
    plan = plan_for(tmp_path)
    before, after = [], []
    original = Handle.flush
    def checked_flush(self):
        if self.handle is not None and self._writable:
            path = self.final_path()
            if path.suffix == ".zip":
                after.append(True)
                raise OSError("synthetic late flush failure")
            before.append(True)
        return original(self)
    monkeypatch.setattr(Handle, "flush", checked_flush)
    destination = tmp_path / "support.zip"
    save(plan, destination)
    assert before and after == []
    with zipfile.ZipFile(destination) as archive:
        assert all(archive.read(entry.alias) == entry.data for entry in plan.entries)


def test_hardlinked_destination_is_never_overwritten(tmp_path):
    original = tmp_path / "keep.txt"
    original.write_bytes(b"keep synthetic bytes")
    destination = tmp_path / "support.zip"
    os.link(original, destination)
    with pytest.raises(files.SupportFileError):
        save(plan_for(tmp_path), destination)
    assert destination.read_bytes() == original.read_bytes() == b"keep synthetic bytes"
    assert list(tmp_path.glob(".sc2tools-support-*.tmp")) == []


def test_retired_owner_before_write_never_creates_archive(tmp_path):
    plan = plan_for(tmp_path)
    with pytest.raises(files.SupportFileError) as error:
        save(plan, tmp_path / "support.zip", is_current=lambda: False)
    assert error.value.code == "cancelled"
    assert list(tmp_path.iterdir()) == []


def test_cancellation_after_first_entry_removes_only_owned_temp(tmp_path, monkeypatch):
    plan = plan_for(tmp_path)
    stop = []
    original = zipfile.ZipFile.writestr
    def cancel_after_entry(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        stop.append(True)
        return result
    monkeypatch.setattr(zipfile.ZipFile, "writestr", cancel_after_entry)
    with pytest.raises(files.SupportFileError) as error:
        save(plan, tmp_path / "support.zip", is_cancelled=lambda: bool(stop))
    assert error.value.code == "cancelled"
    assert stop == [True]
    assert list(tmp_path.iterdir()) == []


def test_retirement_after_rename_and_parent_release_deletes_exact_archive(tmp_path, monkeypatch):
    plan = plan_for(tmp_path)
    retired = []
    original = WindowsFiles.hold_directory
    @contextmanager
    def retire_on_release(self, root):
        with original(self, root) as value:
            yield value
        retired.append(True)
    monkeypatch.setattr(WindowsFiles, "hold_directory", retire_on_release)
    with pytest.raises(files.SupportFileError) as error:
        save(plan, tmp_path / "support.zip", is_current=lambda: not retired)
    assert error.value.code == "cancelled"
    assert retired == [True]
    assert list(tmp_path.iterdir()) == []


def test_storage_probe_is_exclusive_transient_and_preserves_other_files(tmp_path):
    existing = tmp_path / "private-state.json"
    existing.write_bytes(b"untouched synthetic state")
    result = files.probe_storage(tmp_path, is_current=current, is_cancelled=cancelled)
    assert result["status"] == "pass" and result["code"] == "ok"
    assert type(result["count"]) is int and result["count"] >= 0
    assert existing.read_bytes() == b"untouched synthetic state"
    assert list(tmp_path.iterdir()) == [existing]


def test_invalid_direct_plan_and_unsafe_destination_return_fixed_codes(tmp_path):
    with pytest.raises(files.SupportFileError) as error:
        save({"raw_state": "SENTINEL"}, tmp_path / "support.zip")
    assert error.value.code == str(error.value) == "invalid_plan"
    with pytest.raises(files.SupportFileError) as error:
        save(plan_for(tmp_path), tmp_path / "SENTINEL:private.zip")
    assert error.value.code == str(error.value) == "unsafe_path"
    assert list(tmp_path.iterdir()) == []
