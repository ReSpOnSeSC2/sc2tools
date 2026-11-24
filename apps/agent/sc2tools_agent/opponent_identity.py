"""Opponent identity rules shared by the live bridge and Companion views.

The cloud keys every opponent row by its Battle.net toon handle and only
treats a live opponent as the same account when it can match that handle
or the SC2Pulse character id. A display-name match can belong to someone
else, and almost always does for barcode names such as ``IIIIIIIIIIII``.
"""
from __future__ import annotations

import re
from typing import Any, Optional

# Mirrors the cloud's ``isBarcodeLikeName`` (services/opponents.js).
_BARCODE = re.compile(r"[Il1i|ⅠΙＩｌｉ１｜]+")
_TOON = re.compile(r"[1-9][0-9]*-S2-[1-9][0-9]*-[1-9][0-9]*")


def is_barcode_like_name(name: Any) -> bool:
    """Whether ``name`` is a barcode that many accounts share."""
    return isinstance(name, str) and bool(name.strip()) and _BARCODE.fullmatch(name.strip()) is not None


def unambiguous_toon_handle(profile: Any, opponent_name: Any) -> Optional[str]:
    """The SC2Pulse-derived toon handle, only for an unambiguous match.

    Confidence 1.0 needs the exact name on the streamer's server with the
    hinted race, and no other account with that exact name on that server
    among all SC2Pulse hits. Barcodes are excluded even then, since many
    accounts share them.
    """
    toon = getattr(profile, "toon_handle", None)
    confidence = getattr(profile, "confidence", None)
    if not isinstance(toon, str) or _TOON.fullmatch(toon) is None:
        return None
    if type(confidence) not in (int, float) or confidence < 1.0:
        return None
    if is_barcode_like_name(opponent_name) or is_barcode_like_name(getattr(profile, "name", None)):
        return None
    return toon


__all__ = ["is_barcode_like_name", "unambiguous_toon_handle"]
