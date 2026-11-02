"""Approved support text, a draft mailto, and optional headless clipboard."""
from __future__ import annotations

import os
from urllib.parse import urlencode

from ..support_diagnostics import active, diagnostic_bytes

SUPPORT_EMAIL = "responsecoaching@gmail.com"


def support_mailto(snapshot):
    text = diagnostic_bytes(snapshot).decode("utf-8")
    url = "mailto:" + SUPPORT_EMAIL + "?" + urlencode({"subject": "SC2 Tools desktop support", "body": text})
    if len(url) > 16000:
        url = "mailto:" + SUPPORT_EMAIL + "?" + urlencode({"subject": "SC2 Tools desktop support",
            "body": "In SC2 Tools, open Help > Copy support info and paste it into this message."})
    return url


def copy_headless(snapshot, *, is_current, publish=None):
    if not active(is_current, lambda: False):
        return False
    try:
        text = diagnostic_bytes(snapshot).decode("utf-8")
        if publish is None:
            if os.name != "nt":
                return False
            publish = _windows_copy
        return publish(text, is_current) is True and active(is_current, lambda: False)
    except Exception:
        return False


def _windows_copy(text, is_current):
    # No Qt/Tk bootstrap or console fallback. All native work is user-requested.
    import ctypes
    from ctypes import wintypes
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    user.OpenClipboard.argtypes, user.OpenClipboard.restype = [wintypes.HWND], wintypes.BOOL
    user.CloseClipboard.argtypes, user.CloseClipboard.restype = [], wintypes.BOOL
    user.EmptyClipboard.argtypes, user.EmptyClipboard.restype = [], wintypes.BOOL
    user.SetClipboardData.argtypes, user.SetClipboardData.restype = [wintypes.UINT, wintypes.HANDLE], wintypes.HANDLE
    user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, ctypes.c_void_p]
    user.CreateWindowExW.restype = wintypes.HWND
    user.DestroyWindow.argtypes, user.DestroyWindow.restype = [wintypes.HWND], wintypes.BOOL
    kernel.GlobalAlloc.argtypes, kernel.GlobalAlloc.restype = [wintypes.UINT, ctypes.c_size_t], wintypes.HGLOBAL
    kernel.GlobalLock.argtypes, kernel.GlobalLock.restype = [wintypes.HGLOBAL], ctypes.c_void_p
    kernel.GlobalUnlock.argtypes, kernel.GlobalUnlock.restype = [wintypes.HGLOBAL], wintypes.BOOL
    kernel.GlobalFree.argtypes, kernel.GlobalFree.restype = [wintypes.HGLOBAL], wintypes.HGLOBAL
    data = text.encode("utf-16-le") + b"\0\0"
    # EmptyClipboard must have a real owning HWND, including on a tray worker
    # with no Qt window. The predefined class needs no custom window procedure.
    owner = user.CreateWindowExW(0, "STATIC", "SC2 Tools support clipboard", 0, 0, 0, 0, 0,
        wintypes.HWND(-3), None, None, None)  # HWND_MESSAGE: invisible, local to this worker.
    if not owner:
        return False
    block, opened = None, False
    try:
        block = kernel.GlobalAlloc(0x0042, len(data))
        if not block:
            return False
        address = kernel.GlobalLock(block)
        if not address:
            return False
        try:
            ctypes.memmove(address, data, len(data))
        finally:
            kernel.GlobalUnlock(block)
        if not active(is_current, lambda: False) or not user.OpenClipboard(owner):
            return False
        opened = True
        if not active(is_current, lambda: False) or not user.EmptyClipboard():
            return False
        if not active(is_current, lambda: False) or not user.SetClipboardData(13, block):
            return False
        block = None  # Clipboard now owns the allocation.
        return True
    finally:
        try:
            if opened:
                user.CloseClipboard()
        finally:
            try:
                if block:
                    kernel.GlobalFree(block)
            finally:
                user.DestroyWindow(owner)
