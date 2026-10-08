"""Per-user credential storage; never uploaded with agent state or telemetry.

Windows credentials use DPAPI CurrentUser. Other platforms deliberately
require a platform keyring rather than silently writing plaintext tokens.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
import uuid


class SecretStoreError(RuntimeError):
    pass


def _protect(data: bytes, *, decrypt: bool = False) -> bytes:
    if sys.platform != "win32":
        raise SecretStoreError("Platform credential storage is unavailable.")

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if decrypt:
        fn = crypt.CryptUnprotectData
        fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        ok = fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target))
    else:
        fn = crypt.CryptProtectData
        fn.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        ok = fn(ctypes.byref(source), "SC2Tools streaming", None, None, None, 1, ctypes.byref(target))
    if not ok:
        raise SecretStoreError("Windows could not access the saved streaming connection.")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(ctypes.cast(target.data, ctypes.c_void_p))


def write_json(path: Path, value: dict) -> None:
    path = Path(path)
    encoded = _protect(json.dumps(value, ensure_ascii=True).encode("utf-8"))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(b"SC2TOOLS-DPAPI-1\n" + encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(path: Path) -> dict:
    encoded = Path(path).read_bytes()
    prefix = b"SC2TOOLS-DPAPI-1\n"
    if not encoded.startswith(prefix):
        raise SecretStoreError("Reconnect this platform using SC2Tools credential storage.")
    try:
        value = json.loads(_protect(encoded[len(prefix):], decrypt=True))
    except (ValueError, UnicodeError):
        raise SecretStoreError("The saved streaming connection could not be read.") from None
    if not isinstance(value, dict):
        raise SecretStoreError("The saved streaming connection is invalid.")
    return value
