"""Dormant CurrentUser DPAPI and handle-backed credential transaction IO.

Only the explicit credential transaction caller may use these adapters. Ordinary
state loads never instantiate them. Paths, native errors and secret bytes stay
inside this boundary; the caller receives fixed storage error codes.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
import os
from pathlib import Path
import re
import threading
import time
import uuid

from .agent_credentials import (
    CredentialStorageError, MAX_GENERATION_BYTES, MAX_GENERATIONS,
    MAX_GENERATION_TOTAL_BYTES,
)
from . import support_files_windows as native

_GENERATION = re.compile(r"(?:device|obs)-[0-9a-f]{32}\.dpapi\Z")
_ROOT_NAME = "credentials-v1"
# Handle.read's per-call cap. Every native call releases the GIL, so a
# multi-megabyte agent.json is read and written in few, large calls.
_CHUNK = 512 * 1024


def _name(value):
    if type(value) is not str or _GENERATION.fullmatch(value) is None:
        raise CredentialStorageError("invalid_generation")
    return value


def _error_code(error):
    if type(error) is CredentialStorageError:
        return error.code
    if isinstance(error, FileNotFoundError):
        return "missing"
    if isinstance(error, ValueError):
        return "unsafe_path"
    return "unavailable"


class CurrentUserCrypto:
    """Reuse the existing CurrentUser/UI-forbidden primitive, without OAuth IO."""

    def protect(self, data):
        return self._run(data, decrypt=False)

    def unprotect(self, data):
        return self._run(data, decrypt=True)

    @staticmethod
    def _run(data, *, decrypt):
        if type(data) is not bytes or not 0 < len(data) <= MAX_GENERATION_BYTES:
            raise CredentialStorageError("invalid_generation")
        try:
            from .streaming.secret_store import _protect
            result = _protect(data, decrypt=decrypt)
            if type(result) is not bytes or not 0 < len(result) <= MAX_GENERATION_BYTES:
                raise CredentialStorageError("invalid_generation")
            return result
        except Exception:
            pass
        raise CredentialStorageError("unavailable") from None


class WindowsCredentialStorage:
    """One local state directory, immutable generations and exact agent.json CAS.

    This does not acquire the process/state writer locks. Its explicit caller
    must hold both required ownership guards for a complete transaction.
    """

    def __init__(self, state_dir):
        try:
            self._state_dir = native.local_path(state_dir)
            self._files = native.WindowsFiles()
            self._pins = threading.local()
            return
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    @contextmanager
    def transaction(self):
        """Pin the state directory and every ancestor once for a whole transaction.

        Operations inside reuse these held handles instead of reopening each
        ancestor from the drive root per call (about 14 times per commit, each a
        GIL-releasing native round trip). Every handle is verified when opened
        and again when the transaction ends; no write/delete sharing keeps each
        directory in place meanwhile, and identity() re-verifies the state
        directory at every operation boundary. Pins belong to this thread only.
        If the chain cannot be pinned, each operation pins and fails on its own.
        """
        if self._held():
            yield  # The outer transaction owns the pins.
            return
        paths = [*reversed(self._state_dir.parents), self._state_dir]
        handles = []
        try:
            try:
                for path in paths:
                    handles.append(self._files._open(path, native._LIST_DIRECTORY, native._SHARE_READ, 3, directory=True))
            except Exception:
                for handle in reversed(handles):
                    handle.close()
                handles = []
            chain = self._pins.chain = tuple(zip(paths, handles))
            yield
            code = None
            try:
                for path, handle in chain:
                    handle.verify(path, directory=True)
            except Exception as error:
                code = _error_code(error)
            if code is not None:
                raise CredentialStorageError(code) from None
        finally:
            self._pins.chain = ()
            for handle in reversed(handles):
                handle.close()

    def _held(self):
        """This thread's transaction pins as ((path, handle), ...) from the root."""
        return getattr(self._pins, "chain", ())

    def ensure_state_directory(self):
        """Explicit post-instance-lock setup, never called by ordinary reads."""
        try:
            with self._hold(self._state_dir, create=True):
                return self.identity()
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    def identity(self):
        """Read-only physical state-root identity; absence remains unavailable."""
        try:
            held = self._held()
            if held:
                # Re-verify the transaction's continuously pinned state directory.
                path, handle = held[-1]
                volume, identifier = handle.verify(path, directory=True)["identity"]
            else:
                with self._hold(self._state_dir):
                    with self._files._open(self._state_dir, native._LIST_DIRECTORY,
                            native._SHARE_READ, 3, directory=True) as handle:
                        volume, identifier = handle.verify(self._state_dir, directory=True)["identity"]
            return b"SC2Tools-credentials-v1\0" + volume.to_bytes(8, "little") + identifier
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    @contextmanager
    def _hold(self, directory, *, create=False):
        """Pin existing ancestors, creating missing ordinary children one by one.

        Leading directories this thread's transaction already pins stay held by
        it; only deeper ones are opened, verified and closed here.
        """
        paths = [*reversed(directory.parents), directory]
        held = self._held()
        if len(held) > len(paths) or any(str(pinned) != str(path) for (pinned, _), path in zip(held, paths)):
            held = ()
        owned = []
        try:
            for path in paths[len(held):]:
                try:
                    handle = self._files._open(path, native._LIST_DIRECTORY, native._SHARE_READ, 3, directory=True)
                except FileNotFoundError:
                    if not create or not (held or owned):
                        raise
                    try:
                        path.mkdir()  # Non-recursive; the actual parent stays pinned.
                    except FileExistsError:
                        pass
                    handle = self._files._open(path, native._LIST_DIRECTORY, native._SHARE_READ, 3, directory=True)
                owned.append((path, handle))
            yield directory
            for path, handle in owned:
                handle.verify(path, directory=True)
        finally:
            for _path, handle in reversed(owned):
                handle.close()

    def _new(self, path):
        # Write-through includes metadata changes; no OVERLAPPED/asynchronous IO.
        kernel = self._files.kernel
        raw = kernel.CreateFileW(str(path), native._READ | native._WRITE | native._DELETE,
            0, None, 1, native._OPEN_REPARSE | 0x80000000, None)
        if raw is None or raw == native._INVALID:
            raise ctypes.WinError(ctypes.get_last_error())
        handle = native.Handle(kernel, raw, writable=True)
        try:
            handle.verify(path)
            return handle
        except BaseException:
            try:
                handle.discard()
            finally:
                handle.close()
            raise

    @staticmethod
    def _read(handle, path, *, limit=None):
        before = handle.verify(path)
        size = before["size"]
        if limit is not None and not 0 < size <= limit:
            raise CredentialStorageError("invalid_generation")
        handle.seek(0)
        chunks, remaining = [], size
        while remaining:
            chunk = handle.read(min(remaining, _CHUNK))
            if not chunk:
                raise CredentialStorageError("unavailable")
            chunks.append(chunk)
            remaining -= len(chunk)
        if handle.read(1) or handle.verify(path) != before:
            raise CredentialStorageError("unavailable")
        return b"".join(chunks)

    def read_pointer(self):
        try:
            with self._hold(self._state_dir):
                path = self._state_dir / "agent.json"
                try:
                    with self._files.open_read(path) as handle:
                        return self._read(handle, path)
                except FileNotFoundError:
                    return None
        except FileNotFoundError:
            return None
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    def read_generation(self, name):
        name = _name(name)
        try:
            root = self._state_dir / _ROOT_NAME
            with self._hold(root):
                path = root / name
                with self._files.open_read(path) as handle:
                    return self._read(handle, path, limit=MAX_GENERATION_BYTES)
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    def _capacity(self, root):
        count = total = 0
        with os.scandir(root) as entries:
            for entry in entries:
                count += 1
                if count > MAX_GENERATIONS:
                    raise CredentialStorageError("store_full")
                path = root / _name(entry.name)
                with self._files.open_read(path) as handle:
                    info = handle.verify(path)
                    if not 0 < info["size"] <= MAX_GENERATION_BYTES:
                        raise CredentialStorageError("invalid_generation")
                    total += info["size"]
                    if total > MAX_GENERATION_TOTAL_BYTES:
                        raise CredentialStorageError("store_full")
        return count, total

    def capacity(self):
        try:
            with self._hold(self._state_dir / _ROOT_NAME) as root:
                return self._capacity(root)
        except FileNotFoundError:
            return 0, 0
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    def create_generation(self, name, data):
        name = _name(name)
        if type(data) is not bytes or not 0 < len(data) <= MAX_GENERATION_BYTES:
            raise CredentialStorageError("invalid_generation")
        try:
            with self._hold(self._state_dir / _ROOT_NAME, create=True) as root:
                count, total = self._capacity(root)
                if count >= MAX_GENERATIONS or total + len(data) > MAX_GENERATION_TOTAL_BYTES:
                    raise CredentialStorageError("store_full")
                path = root / name
                with self._new(path) as handle:
                    try:
                        handle.write(data)
                        handle.flush()
                        if self._read(handle, path, limit=MAX_GENERATION_BYTES) != data:
                            raise CredentialStorageError("write_failed")
                    except BaseException:
                        handle.discard()  # Exact newly created handle; never a path fallback.
                        raise
            return
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None

    @staticmethod
    def _rename_pointer(handle, destination):
        if destination.name != "agent.json" or not native._same(handle.final_path().parent, destination.parent):
            raise CredentialStorageError("unsafe_path")
        encoded = destination.name.encode("utf-16-le")
        buffer = ctypes.create_string_buffer(ctypes.sizeof(native._RenameInfo) + len(encoded) + 2)
        header = ctypes.cast(buffer, ctypes.POINTER(native._RenameInfo)).contents
        header.replace, header.root, header.name_length = True, None, len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + native._RenameInfo.name.offset, encoded, len(encoded))
        api, status = native._native(), native._IoStatus()
        result = api.NtSetInformationFile(handle.handle, ctypes.byref(status), buffer, len(buffer), 10)
        if result == 0x103:
            if handle.kernel.WaitForSingleObject(handle.handle, 0xFFFFFFFF) != 0:
                raise ctypes.WinError(ctypes.get_last_error())
            result = status.status
        if result:
            raise ctypes.WinError(api.RtlNtStatusToDosError(result))

    def replace_pointer(self, expected, data):
        if (expected is not None and type(expected) is not bytes) or type(data) is not bytes or not data:
            raise CredentialStorageError("invalid_pointer")
        try:
            with self._hold(self._state_dir, create=True):
                if self.read_pointer() != expected:
                    raise CredentialStorageError("conflict")
                temporary = self._state_dir / ("agent-credentials-" + uuid.uuid4().hex + ".tmp")
                destination = self._state_dir / "agent.json"
                with self._new(temporary) as handle:
                    try:
                        for start in range(0, len(data), _CHUNK):
                            handle.write(data[start:start + _CHUNK])
                        handle.flush()
                        if self._read(handle, temporary) != data:
                            raise CredentialStorageError("write_failed")
                        if self.read_pointer() != expected:
                            raise CredentialStorageError("conflict")
                        for attempt in range(6):
                            try:
                                self._rename_pointer(handle, destination)
                                break
                            except PermissionError as error:
                                if getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 5:
                                    raise
                                time.sleep(0.01 * 2 ** attempt)
                        handle.verify(destination)
                        handle.flush()
                        if self._read(handle, destination) != data:
                            raise CredentialStorageError("write_failed")
                    finally:
                        # A failed call may already have selected the new document.
                        # Delete only if this exact owned handle still has its temp name.
                        try:
                            if native._same(handle.final_path(), temporary):
                                handle.verify(temporary)
                                handle.discard()
                        except (OSError, ValueError):
                            pass
            return
        except Exception as error:
            code = _error_code(error)
        raise CredentialStorageError(code) from None
