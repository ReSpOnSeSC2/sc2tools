"""Small Windows handle adapter for reviewed support files; imported lazily.

Every directory remains open without write/delete sharing until work ends.
Files are opened as reparse points, then verified through those same handles.
The adapter never logs paths or exception text.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import io
import ntpath
import os
from pathlib import Path

_DIRECTORY = 0x10
_REPARSE = 0x400
_READ = 0x80000000
_WRITE = 0x40000000
_DELETE = 0x10000
_LIST_DIRECTORY = 0x1
_SHARE_READ = 1
_SHARE_WRITE = 2
_OPEN_REPARSE = 0x00200000
_BACKUP = 0x02000000
_INVALID = ctypes.c_void_p(-1).value


class _Info(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
        ("accessed", wintypes.FILETIME), ("modified", wintypes.FILETIME),
        ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
        ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
        ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]


class _IdInfo(ctypes.Structure):
    _fields_ = [("volume", ctypes.c_ulonglong), ("identifier", ctypes.c_ubyte * 16)]


class _RenameInfo(ctypes.Structure):
    _fields_ = [("replace", wintypes.BOOLEAN), ("root", wintypes.HANDLE),
        ("name_length", wintypes.DWORD), ("name", wintypes.WCHAR * 1)]


class _StatusValue(ctypes.Union):
    _fields_ = [("status", wintypes.LONG), ("pointer", ctypes.c_void_p)]


class _IoStatus(ctypes.Structure):
    _anonymous_ = ("value",)
    _fields_ = [("value", _StatusValue), ("information", ctypes.c_size_t)]


def _native():
    native = ctypes.WinDLL("ntdll", use_last_error=True)
    native.NtSetInformationFile.argtypes = [wintypes.HANDLE, ctypes.POINTER(_IoStatus), ctypes.c_void_p, wintypes.ULONG, ctypes.c_int]
    native.NtSetInformationFile.restype = wintypes.LONG
    native.RtlNtStatusToDosError.argtypes = [wintypes.LONG]
    native.RtlNtStatusToDosError.restype = wintypes.ULONG
    return native


def _kernel():
    if os.name != "nt":
        raise OSError("support_files_unavailable")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateFileW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE], wintypes.HANDLE),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        "GetFileInformationByHandle": ([wintypes.HANDLE, ctypes.POINTER(_Info)], wintypes.BOOL),
        "GetFileInformationByHandleEx": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "GetFinalPathNameByHandleW": ([wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD], wintypes.DWORD),
        "ReadFile": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        "WriteFile": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        "SetFilePointerEx": ([wintypes.HANDLE, ctypes.c_longlong, ctypes.POINTER(ctypes.c_longlong), wintypes.DWORD], wintypes.BOOL),
        "FlushFileBuffers": ([wintypes.HANDLE], wintypes.BOOL),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "SetFileInformationByHandle": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result
    return kernel


def local_path(value):
    """Accept an ordinary absolute local path, without namespace/ADS aliases."""
    if type(value) not in (str, type(Path())):
        raise ValueError("unsafe_path")
    text = os.fspath(value)
    if not 3 <= len(text) <= 4096 or "\x00" in text or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
        raise ValueError("unsafe_path")
    text = text.replace("/", "\\")
    drive, tail = ntpath.splitdrive(text)
    if len(drive) != 2 or drive[1] != ":" or not drive[0].isascii() or not drive[0].isalpha() or not tail.startswith("\\"):
        raise ValueError("unsafe_path")
    parts = tail.split("\\")[1:]
    if parts and parts[-1] == "":
        parts.pop()
    reserved = {"CON", "PRN", "AUX", "NUL"}
    # Windows also reserves COM/LPT with superscript1/2/3 in every directory.
    reserved.update(prefix + digit for prefix in ("COM", "LPT") for digit in "123456789\u00b9\u00b2\u00b3")
    for part in parts:
        if (not part or part in (".", "..") or part[-1] in (" ", ".")
            or any(ord(c) < 32 or c in '<>:"|?*' for c in part)
            or part.split(".")[0].upper() in reserved):
            raise ValueError("unsafe_path")
    return Path(drive.upper() + "\\" + "\\".join(parts))


def _same(left, right):
    return ntpath.normcase(str(left)) == ntpath.normcase(str(right))


class Handle(io.RawIOBase):
    def __init__(self, kernel, handle, *, writable=False):
        super().__init__()
        self.kernel, self.handle, self._writable = kernel, handle, writable

    def _check(self, result):
        if not result:
            error = ctypes.get_last_error()
            raise ctypes.WinError(error)
        return result

    def readable(self):
        return True

    def writable(self):
        return self._writable

    def seekable(self):
        return True

    def seek(self, offset, whence=os.SEEK_SET):
        if whence not in (os.SEEK_SET, os.SEEK_CUR, os.SEEK_END):
            raise ValueError("invalid_seek")
        position = ctypes.c_longlong()
        self._check(self.kernel.SetFilePointerEx(self.handle, offset, ctypes.byref(position), whence))
        return position.value

    def tell(self):
        return self.seek(0, os.SEEK_CUR)

    def read(self, size=-1):
        if type(size) is not int or not 0 <= size <= 512 * 1024:
            raise ValueError("unbounded_support_read")
        buffer = ctypes.create_string_buffer(size)
        actual = wintypes.DWORD()
        self._check(self.kernel.ReadFile(self.handle, buffer, size, ctypes.byref(actual), None))
        return buffer.raw[:actual.value]

    def write(self, data):
        if not self._writable or not isinstance(data, (bytes, bytearray, memoryview)):
            raise ValueError("invalid_support_write")
        data = bytes(data)
        if len(data) > 1024 * 1024:
            raise ValueError("unbounded_support_write")
        buffer = ctypes.create_string_buffer(data)
        actual = wintypes.DWORD()
        self._check(self.kernel.WriteFile(self.handle, buffer, len(data), ctypes.byref(actual), None))
        if actual.value != len(data):
            raise OSError("short_support_write")
        return actual.value

    def flush(self):
        if not self.closed and self.handle is not None and self._writable:
            self._check(self.kernel.FlushFileBuffers(self.handle))

    def close(self):
        if self.closed:
            return
        # This raw adapter has no Python write buffer. Callers explicitly flush
        # before publication; RawIOBase.close must not add a fallible disk flush
        # after the owned temporary file has already been renamed.
        handle, self.handle = self.handle, None
        try:
            super().close()
        finally:
            if handle is not None:
                self.kernel.CloseHandle(handle)

    def information(self):
        basic, identity = _Info(), _IdInfo()
        self._check(self.kernel.GetFileInformationByHandle(self.handle, ctypes.byref(basic)))
        # FileIdInfo=18 includes the full 128-bit ReFS/NTFS identifier.
        self._check(self.kernel.GetFileInformationByHandleEx(self.handle, 18, ctypes.byref(identity), ctypes.sizeof(identity)))
        return {
            "attributes": basic.attributes, "links": basic.links,
            "identity": (identity.volume, bytes(identity.identifier)),
            "size": (basic.size_high << 32) | basic.size_low,
            "modified": (basic.modified.dwHighDateTime << 32) | basic.modified.dwLowDateTime,
        }

    def final_path(self):
        buffer = ctypes.create_unicode_buffer(8192)
        length = self.kernel.GetFinalPathNameByHandleW(self.handle, buffer, len(buffer), 0)
        if not length or length >= len(buffer):
            raise OSError("support_path_unavailable")
        text = buffer.value
        if text.startswith("\\\\?\\"):
            text = text[4:]
        return local_path(text)

    def verify(self, expected, *, directory=False):
        info = self.information()
        if (bool(info["attributes"] & _DIRECTORY) != directory or info["attributes"] & _REPARSE
            or not directory and info["links"] != 1 or not _same(self.final_path(), expected)):
            raise ValueError("unsafe_path")
        return info

    def rename_new(self, destination):
        destination = local_path(destination)
        if not _same(self.final_path().parent, destination.parent):
            raise ValueError("unsafe_path")
        # Native FileRenameInformation with a simple basename/NULL root renames
        # only within the source directory. It avoids a conflicting target-
        # parent WRITE reopen while the parent/ancestor LIST handles stay held.
        # https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
        encoded = destination.name.encode("utf-16-le")
        offset = _RenameInfo.name.offset
        buffer = ctypes.create_string_buffer(ctypes.sizeof(_RenameInfo) + len(encoded) + 2)
        header = ctypes.cast(buffer, ctypes.POINTER(_RenameInfo)).contents
        header.replace, header.root, header.name_length = False, None, len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + offset, encoded, len(encoded))
        native, status = _native(), _IoStatus()
        result = native.NtSetInformationFile(self.handle, ctypes.byref(status), buffer, len(buffer), 10)
        if result == 0x103:  # STATUS_PENDING: keep the status buffer/admission alive.
            if self.kernel.WaitForSingleObject(self.handle, 0xFFFFFFFF) != 0:
                raise ctypes.WinError(ctypes.get_last_error())
            result = status.status
        if result != 0:
            raise ctypes.WinError(native.RtlNtStatusToDosError(result))

    def discard(self):
        # FileDispositionInfo=4 deletes this exact owned handle on close.
        delete = wintypes.BOOLEAN(True)
        self._check(self.kernel.SetFileInformationByHandle(self.handle, 4, ctypes.byref(delete), ctypes.sizeof(delete)))


class WindowsFiles:
    def __init__(self):
        self.kernel = _kernel()

    def _open(self, path, access, sharing, creation, *, directory=False, writable=False):
        flags = _OPEN_REPARSE | (_BACKUP if directory else 0)
        handle = self.kernel.CreateFileW(str(path), access, sharing, None, creation, flags, None)
        if handle == _INVALID or handle is None:
            raise ctypes.WinError(ctypes.get_last_error())
        result = Handle(self.kernel, handle, writable=writable)
        try:
            result.verify(path, directory=directory)
        except BaseException:
            try:
                if creation == 1:
                    result.discard()
            finally:
                result.close()
            raise
        return result

    @contextmanager
    def hold_directory(self, directory):
        directory = local_path(directory)
        paths = [*reversed(directory.parents), directory]
        handles = []
        try:
            for path in paths:
                # A zero-access metadata handle does not enforce rename sharing
                # on Windows. FILE_LIST_DIRECTORY participates in share checks;
                # no write/delete sharing keeps this directory and ancestors pinned.
                handles.append(self._open(path, _LIST_DIRECTORY, _SHARE_READ, 3, directory=True))
            yield directory
            for path, handle in zip(paths, handles):
                handle.verify(path, directory=True)
        finally:
            for handle in reversed(handles):
                handle.close()

    def open_read(self, path):
        return self._open(local_path(path), _READ, _SHARE_READ | _SHARE_WRITE, 3)

    def create_new(self, path):
        return self._open(local_path(path), _READ | _WRITE | _DELETE, 0, 1, writable=True)
