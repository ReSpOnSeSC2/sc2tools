"""Whether Windows shows animations; this module is Qt-free.

Settings > Accessibility > Visual effects > Animation effects is the switch
browsers read for "prefers reduced motion". The agent's window motion plays
only when both this switch and the player's Border and animations choice are on.
"""
from __future__ import annotations

import ctypes
import sys

SPI_GETCLIENTAREAANIMATION = 0x1042


def _client_area_animation():
    """Windows' animation switch as 0 or 1, or ``None`` when Windows cannot say."""
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        query = user32.SystemParametersInfoW
    except (AttributeError, OSError):
        return None
    query.argtypes = (ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint)
    query.restype = ctypes.c_int
    enabled = ctypes.c_int(1)
    if not query(SPI_GETCLIENTAREAANIMATION, 0, ctypes.byref(enabled), 0):
        return None
    return 1 if enabled.value else 0


def animations_enabled():
    """False only when Windows reports animation effects off; an unknown answer keeps motion."""
    if sys.platform != "win32":
        return True
    return _client_area_animation() != 0
