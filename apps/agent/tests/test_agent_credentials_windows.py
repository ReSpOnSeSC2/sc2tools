"""Owned temporary Windows files and synthetic DPAPI values only."""
import os
from pathlib import Path

import pytest

from sc2tools_agent.agent_credentials import (
    CredentialStorageError, MAX_GENERATION_BYTES, MAX_GENERATIONS,
)
from sc2tools_agent import agent_credentials_windows as windows

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows credential handle boundary")


def name(number=1, slot="device"):
    return f"{slot}-{number:032x}.dpapi"


def test_absent_reads_and_capacity_do_not_create_state_or_generation_roots(tmp_path):
    root = tmp_path / "absent" / "state"
    store = windows.WindowsCredentialStorage(root)
    assert store.read_pointer() is None
    assert store.capacity() == (0, 0)
    with pytest.raises(CredentialStorageError, match="^missing$"):
        store.identity()
    assert not (tmp_path / "absent").exists()


def test_explicit_root_setup_and_generation_creation_pin_new_ordinary_ancestors(tmp_path):
    root = tmp_path / "new" / "installation" / "state"
    store = windows.WindowsCredentialStorage(root)
    identity = store.ensure_state_directory()
    assert type(identity) is bytes and 1 <= len(identity) <= 256
    assert store.identity() == identity
    assert not (root / "agent.json").exists()
    payload = b"synthetic ciphertext, not a real credential"
    store.create_generation(name(), payload)
    assert store.read_generation(name()) == payload
    assert store.capacity() == (1, len(payload))
    assert store.identity() == identity


def test_physical_installation_identity_is_distinct_and_stable(tmp_path):
    first = windows.WindowsCredentialStorage(tmp_path / "first")
    second = windows.WindowsCredentialStorage(tmp_path / "second")
    first_id, second_id = first.ensure_state_directory(), second.ensure_state_directory()
    assert first_id != second_id
    assert first.identity() == first_id and second.identity() == second_id
    assert str(tmp_path).encode() not in first_id + second_id


@pytest.mark.parametrize("bad", ["../agent.json", "device-a.dpapi", "obs-" + "A" * 32 + ".dpapi", "C:/other", "agent.json"])
def test_generation_aliases_are_rejected_before_any_filesystem_creation(tmp_path, bad):
    root = tmp_path / "state"
    store = windows.WindowsCredentialStorage(root)
    with pytest.raises(CredentialStorageError, match="^invalid_generation$"):
        store.create_generation(bad, b"opaque")
    assert not root.exists()


def test_generation_is_exclusive_and_existing_bytes_are_never_overwritten(tmp_path):
    store = windows.WindowsCredentialStorage(tmp_path / "state")
    store.create_generation(name(), b"first opaque generation")
    with pytest.raises(CredentialStorageError):
        store.create_generation(name(), b"replacement must never win")
    assert store.read_generation(name()) == b"first opaque generation"
    assert store.capacity() == (1, len(b"first opaque generation"))


def test_generation_bounds_are_checked_before_reading_or_allocating_more(tmp_path, monkeypatch):
    root = tmp_path / "state"
    store = windows.WindowsCredentialStorage(root)
    with pytest.raises(CredentialStorageError, match="^invalid_generation$"):
        store.create_generation(name(), b"x" * (MAX_GENERATION_BYTES + 1))
    assert not root.exists()
    directory = root / "credentials-v1"
    directory.mkdir(parents=True)
    (directory / name()).write_bytes(b"x" * (MAX_GENERATION_BYTES + 1))
    monkeypatch.setattr(windows.native.Handle, "read", lambda *args: pytest.fail("oversized generation was read"))
    with pytest.raises(CredentialStorageError, match="^invalid_generation$"):
        store.read_generation(name())


def test_actual_generation_count_boundary_does_not_select_or_overwrite_any_file(tmp_path):
    root = tmp_path / "state"
    directory = root / "credentials-v1"
    directory.mkdir(parents=True)
    for number in range(MAX_GENERATIONS):
        (directory / name(number)).write_bytes(b"x")
    store = windows.WindowsCredentialStorage(root)
    assert store.capacity() == (MAX_GENERATIONS, MAX_GENERATIONS)
    with pytest.raises(CredentialStorageError, match="^store_full$"):
        store.create_generation(name(MAX_GENERATIONS), b"new")
    assert len(tuple(directory.iterdir())) == MAX_GENERATIONS
    assert not (root / "agent.json").exists()


def test_hardlinked_generation_is_rejected_before_any_read(tmp_path, monkeypatch):
    root = tmp_path / "state"
    directory = root / "credentials-v1"
    directory.mkdir(parents=True)
    outside = tmp_path / "synthetic-other-file"
    outside.write_bytes(b"owned synthetic bytes")
    os.link(outside, directory / name())
    monkeypatch.setattr(windows.native.Handle, "read", lambda *args: pytest.fail("hardlinked generation was read"))
    store = windows.WindowsCredentialStorage(root)
    with pytest.raises(CredentialStorageError, match="^unsafe_path$"):
        store.read_generation(name())
    assert outside.read_bytes() == b"owned synthetic bytes"


def test_junction_generation_root_is_rejected_without_touching_target(tmp_path):
    import _winapi
    root, outside = tmp_path / "state", tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    sentinel = outside / name()
    sentinel.write_bytes(b"owned outside sentinel")
    junction = root / "credentials-v1"
    _winapi.CreateJunction(str(outside), str(junction))
    try:
        store = windows.WindowsCredentialStorage(root)
        with pytest.raises(CredentialStorageError, match="^unsafe_path$"):
            store.read_generation(name())
        with pytest.raises(CredentialStorageError, match="^unsafe_path$"):
            store.create_generation(name(2), b"must not reach target")
        assert sorted(path.name for path in outside.iterdir()) == [name()]
        assert sentinel.read_bytes() == b"owned outside sentinel"
    finally:
        os.rmdir(junction)  # Remove only this owned junction, retaining its target.


def test_directory_itself_cannot_be_renamed_while_pinned(tmp_path):
    root = tmp_path / "state"
    root.mkdir()
    store = windows.WindowsCredentialStorage(root)
    renamed = tmp_path / "renamed"
    with store._hold(root):
        with pytest.raises(OSError) as error:
            root.rename(renamed)
        assert error.value.winerror == 32
    root.rename(renamed)
    assert renamed.is_dir() and not root.exists()


def test_pointer_replaces_complete_document_with_exact_expected_raw_bytes(tmp_path):
    root = tmp_path / "state"
    store = windows.WindowsCredentialStorage(root)
    first = b'{ "uploaded": {"synthetic": "done"}, "credentials": {"version": 1} }'
    second = b'{"uploaded":{"synthetic":"done"},"credentials":{"version":1,"device":null}}'
    store.replace_pointer(None, first)
    assert store.read_pointer() == first
    store.replace_pointer(first, second)
    assert (root / "agent.json").read_bytes() == second
    assert sorted(path.name for path in root.iterdir()) == ["agent.json"]


def test_pointer_conflict_preserves_original_document_and_leaves_no_temp(tmp_path):
    root = tmp_path / "state"
    root.mkdir()
    original = b'{"uploaded":{"kept":"value"}}'
    (root / "agent.json").write_bytes(original)
    store = windows.WindowsCredentialStorage(root)
    with pytest.raises(CredentialStorageError, match="^conflict$"):
        store.replace_pointer(original + b" ", b'{"credentials":{}}')
    assert (root / "agent.json").read_bytes() == original
    assert sorted(path.name for path in root.iterdir()) == ["agent.json"]


def test_pointer_changed_after_temp_flush_is_preserved_by_second_raw_fence(tmp_path, monkeypatch):
    root = tmp_path / "state"
    store = windows.WindowsCredentialStorage(root)
    original, newer = b'{"old":true}', b'{"newer":"must survive"}'
    store.replace_pointer(None, original)
    read = store._read
    replaced = []

    def changed_after_readback(handle, path, *, limit=None):
        result = read(handle, path, limit=limit)
        if path.name.startswith("agent-credentials-") and not replaced:
            (root / "agent.json").write_bytes(newer)
            replaced.append(True)
        return result

    monkeypatch.setattr(store, "_read", changed_after_readback)
    with pytest.raises(CredentialStorageError, match="^conflict$"):
        store.replace_pointer(original, b'{"candidate":"obsolete"}')
    assert replaced == [True]
    assert (root / "agent.json").read_bytes() == newer
    assert sorted(path.name for path in root.iterdir()) == ["agent.json"]


@pytest.mark.parametrize("exhaust", [False, True])
def test_pointer_permission_retry_reuses_one_flushed_temp_and_native_handle(tmp_path, monkeypatch, exhaust):
    import ctypes
    root = tmp_path / "state"
    store = windows.WindowsCredentialStorage(root)
    original, candidate = b'{"old":true}', b'{"candidate":"whole document"}'
    store.replace_pointer(None, original)
    rename = windows.WindowsCredentialStorage._rename_pointer
    calls, delays = [], []

    def transient(handle, destination):
        temporary = handle.final_path()
        calls.append((handle.handle, temporary))
        assert (root / "agent.json").read_bytes() == original
        assert store._read(handle, temporary) == candidate
        if exhaust or len(calls) <= 2:
            raise ctypes.WinError(32)
        rename(handle, destination)

    monkeypatch.setattr(windows.WindowsCredentialStorage, "_rename_pointer", staticmethod(transient))
    monkeypatch.setattr(windows.time, "sleep", delays.append)
    if exhaust:
        with pytest.raises(CredentialStorageError, match="^unavailable$"):
            store.replace_pointer(original, candidate)
    else:
        store.replace_pointer(original, candidate)
    assert len(calls) == (6 if exhaust else 3)
    assert len({raw for raw, _path in calls}) == len({path for _raw, path in calls}) == 1
    assert delays == ([0.01, 0.02, 0.04, 0.08, 0.16] if exhaust else [0.01, 0.02])
    assert (root / "agent.json").read_bytes() == (original if exhaust else candidate)
    assert sorted(path.name for path in root.iterdir()) == ["agent.json"]


def test_hardlinked_pointer_is_rejected_before_replacement(tmp_path):
    root = tmp_path / "state"
    root.mkdir()
    outside = tmp_path / "other-owned-document"
    outside.write_bytes(b'{"preserve":"outside"}')
    os.link(outside, root / "agent.json")
    store = windows.WindowsCredentialStorage(root)
    with pytest.raises(CredentialStorageError, match="^unsafe_path$"):
        store.replace_pointer(outside.read_bytes(), b'{"credentials":{}}')
    assert outside.read_bytes() == (root / "agent.json").read_bytes() == b'{"preserve":"outside"}'


def test_failure_after_real_pointer_rename_keeps_selected_document(tmp_path, monkeypatch):
    root = tmp_path / "state"
    store = windows.WindowsCredentialStorage(root)
    original, candidate = b'{"old":true}', b'{"credentials":{"version":1},"new":true}'
    store.replace_pointer(None, original)
    rename = windows.WindowsCredentialStorage._rename_pointer

    def committed_then_failed(handle, destination):
        rename(handle, destination)
        raise OSError("synthetic private failure detail must remain internal")

    monkeypatch.setattr(windows.WindowsCredentialStorage, "_rename_pointer", staticmethod(committed_then_failed))
    with pytest.raises(CredentialStorageError, match="^unavailable$") as failure:
        store.replace_pointer(original, candidate)
    assert "private failure" not in str(failure.value)
    assert (root / "agent.json").read_bytes() == candidate
    assert sorted(path.name for path in root.iterdir()) == ["agent.json"]


def test_actual_current_user_dpapi_roundtrip_and_tamper_failure_use_synthetic_value():
    crypto = windows.CurrentUserCrypto()
    sentinel = b"synthetic-fixture-secret-not-an-installed-credential"
    encrypted = crypto.protect(sentinel)
    assert sentinel not in encrypted
    assert crypto.unprotect(encrypted) == sentinel
    corrupted = bytearray(encrypted)
    corrupted[len(corrupted) // 2] ^= 0x40
    with pytest.raises(CredentialStorageError, match="^unavailable$"):
        crypto.unprotect(bytes(corrupted))


def test_native_failure_has_only_fixed_error_code(tmp_path, monkeypatch):
    store = windows.WindowsCredentialStorage(tmp_path)

    def failed(*args, **kwargs):
        raise OSError("synthetic token and path must not reach caller")

    monkeypatch.setattr(store._files, "open_read", failed)
    with pytest.raises(CredentialStorageError, match="^unavailable$") as failure:
        store.read_pointer()
    assert failure.value.args == ("unavailable",)
    assert "synthetic token" not in repr(failure.value)
    assert failure.value.__context__ is None and failure.value.__cause__ is None
