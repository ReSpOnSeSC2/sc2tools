"""Tell a replay that can't be read right now from one that can't be read at all.

A parse that fails because OneDrive (or another cloud provider) hasn't
downloaded the file yet, or because another program holds it open, says
nothing about the replay. The watcher keeps such a replay unmarked and tries
it again later instead of recording a permanent ``parse_failed`` skip.
Stdlib-only; safe to import in parse worker processes.
"""
from __future__ import annotations

import os

# Windows error codes for "in use" and for cloud-provider conditions that pass:
# 32 sharing violation, 33 lock violation, 362 provider not running,
# 369/371 provider unavailable or busy, 386 provider sign-in failed,
# 387 low resources, 388 network unavailable, 389 cloud operation failed,
# 391 cloud file in use, 393 aborted, 397 property lock conflict,
# 398 cancelled by the user, 404 provider exited.
TRANSIENT_WINERRORS = frozenset({32, 33, 362, 369, 371, 386, 387, 388, 389, 391, 393, 397, 398, 404})
# FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS:
# the file's data is not on this PC yet (a cloud-only placeholder).
CLOUD_PLACEHOLDER_ATTRIBUTES = 0x1000 | 0x40000 | 0x400000


def transient_os_error(exc: BaseException) -> bool:
    return isinstance(exc, OSError) and getattr(exc, "winerror", None) in TRANSIENT_WINERRORS


def temporarily_unreadable(path) -> bool:
    """True when ``path`` is still a cloud placeholder or another program holds it.

    Checks the attributes first, so a placeholder is never downloaded just to
    answer. Never raises.
    """
    try:
        attributes = getattr(os.stat(path), "st_file_attributes", 0) or 0
    except OSError as exc:
        return transient_os_error(exc)
    except (TypeError, ValueError):
        return False
    if attributes & CLOUD_PLACEHOLDER_ATTRIBUTES:
        return True
    try:
        with open(path, "rb") as handle:
            handle.read(1)
    except OSError as exc:
        return transient_os_error(exc)
    return False


__all__ = ["CLOUD_PLACEHOLDER_ATTRIBUTES", "TRANSIENT_WINERRORS", "temporarily_unreadable", "transient_os_error"]
