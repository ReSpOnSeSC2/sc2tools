"""Synthetic Win32 clipboard ABI/ownership contract; never load native DLLs."""
import ctypes
from types import SimpleNamespace

import pytest

from sc2tools_agent.ui.support_actions import _windows_copy


class Function:
    def __init__(self, callback):
        self.callback = callback

    def __call__(self, *args):
        return self.callback(*args)


@pytest.mark.parametrize("outcome", ["success", "create", "allocate", "lock", "open", "empty", "set", "retire"])
def test_clipboard_owns_nonnull_message_window_and_transfers_or_frees_buffer(monkeypatch, outcome):
    calls, copied = [], []
    state = {"current": True}
    failures = {"create": "CreateWindowExW", "allocate": "GlobalAlloc", "lock": "GlobalLock",
        "open": "OpenClipboard", "empty": "EmptyClipboard", "set": "SetClipboardData"}

    def function(name, result):
        def invoke(*args):
            calls.append((name, args))
            if name == "CreateWindowExW":
                assert args[1] == "STATIC"
                assert args[8].value == ctypes.c_void_p(-3).value  # HWND_MESSAGE, not a visible parent.
            if name == "OpenClipboard":
                assert args[0] == 777  # A non-null HWND is required after EmptyClipboard.
                if outcome == "retire":
                    state["current"] = False
            if name == "GlobalAlloc":
                assert args[0] & 0x0002  # Clipboard HGLOBAL must be movable.
            if name == "SetClipboardData":
                assert args == (13, 888)  # CF_UNICODETEXT and the owned allocation.
            return 0 if failures.get(outcome) == name else result
        return Function(invoke)

    user = SimpleNamespace(**{name: function(name, result) for name, result in {
        "CreateWindowExW": 777, "DestroyWindow": 1, "OpenClipboard": 1, "CloseClipboard": 1,
        "EmptyClipboard": 1, "SetClipboardData": 888}.items()})
    kernel = SimpleNamespace(**{name: function(name, result) for name, result in {
        "GlobalAlloc": 888, "GlobalLock": 999, "GlobalUnlock": 1, "GlobalFree": 0}.items()})
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **_kwargs: {"user32": user, "kernel32": kernel}[name], raising=False)
    monkeypatch.setattr(ctypes, "memmove", lambda address, data, length: copied.append((address, data, length)))
    result = _windows_copy("safe support text", lambda: state["current"])
    names = [name for name, _args in calls]
    assert result is (outcome == "success")
    assert names.count("DestroyWindow") == (0 if outcome == "create" else 1)
    assert names.count("CloseClipboard") == (1 if outcome in ("success", "empty", "set", "retire") else 0)
    assert names.count("GlobalFree") == (1 if outcome in ("lock", "open", "empty", "set", "retire") else 0)
    if outcome == "success":
        assert names.index("GlobalLock") < names.index("GlobalUnlock") < names.index("OpenClipboard")
        assert names.index("EmptyClipboard") < names.index("SetClipboardData") < names.index("CloseClipboard") < names.index("DestroyWindow")
        assert copied == [(999, "safe support text".encode("utf-16-le") + b"\0\0", len("safe support text".encode("utf-16-le")) + 2)]
    if outcome == "retire":
        assert "EmptyClipboard" not in names and "SetClipboardData" not in names
