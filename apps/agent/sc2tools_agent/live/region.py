"""Region-byte helper for the live-bridge layer.

Blizzard's toon-handle wire format is ``<region>-S2-<realm>-<bnid>``;
the leading numeric byte identifies the server cluster. We need this
inside the live bridge so a ``set_user_toon_handle`` call can detect
NA → EU → KR transitions across consecutive observations and force a
synthetic ``MENU → MATCH_LOADING`` prelude instead of letting the
overlay sit on the previous server's opponent until the streamer
manually refreshes their Browser Source.

Mirrors ``apps/api/src/util/regionFromToonHandle.js`` exactly — the
two sides agree on which numeric prefix maps to which label so the
cloud's region-aware enrichment cache and the agent's transition
detector classify the same handle the same way. The
``apps/agent/sc2tools_agent/uploader/queue.py`` module also keeps a
private copy for replay-row regioning; we leave that one alone to
avoid coupling the uploader to the live module's import graph.
"""

from __future__ import annotations

from typing import Optional


_TOON_HANDLE_REGION_BYTE = {
    "1": "NA",
    "2": "EU",
    "3": "KR",
    "5": "CN",
    "6": "SEA",
}


def region_from_toon_handle(handle: Optional[str]) -> Optional[str]:
    """Return the canonical Blizzard region label for ``handle``.

    Returns ``None`` for empty / malformed / unknown-prefix handles
    so the caller can leave region undefined rather than mis-label.

    >>> region_from_toon_handle("1-S2-1-12345")
    'NA'
    >>> region_from_toon_handle("2-S2-1-12345")
    'EU'
    >>> region_from_toon_handle("3-S2-1-12345")
    'KR'
    >>> region_from_toon_handle(None) is None
    True
    >>> region_from_toon_handle("99-S2-1-12345") is None
    True
    """
    if not isinstance(handle, str) or not handle:
        return None
    head = handle.split("-", 1)[0]
    return _TOON_HANDLE_REGION_BYTE.get(head)


__all__ = ["region_from_toon_handle"]
