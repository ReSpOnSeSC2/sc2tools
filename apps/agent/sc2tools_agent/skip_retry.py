"""Give replays an older engine couldn't read one more try after each update.

Replays skipped as ``parse_failed``, ``analysis_failed`` or
``unsupported_replay`` used to stay skipped until a full Re-sync, even when
the next release could read them; that happens after every StarCraft II
patch. The replay engine and sc2reader ship inside the agent, so the agent
version identifies the engine. The first time a version starts, those skip
markers are released and the watcher parses the replays again; replays the
new engine still can't read are skipped again and wait for the next update.
A marker for a file that is gone just disappears: the watcher never finds the
file, so nothing is parsed. No file is touched here, so boot never waits on a
slow or offline replay folder.
"""
from __future__ import annotations

from . import __version__
from .state import _STATE_SAVE_LOCK, save_state

ENGINE_RETRY_REASONS = ("analysis_failed", "parse_failed", "unsupported_replay")
_MARKERS = frozenset("skipped:" + reason for reason in ENGINE_RETRY_REASONS)


def release_engine_skips(state, state_dir, *, version=__version__, save=save_state):
    """Once per agent version, forget the skips a newer engine may read. Returns how many."""
    with _STATE_SAVE_LOCK:
        if state.skip_retry_version == version:
            return 0
        previous = state.skip_retry_version
        released = {path: marker for path, marker in dict(state.uploaded).items() if marker in _MARKERS}
        for path in released:
            del state.uploaded[path]
        state.skip_retry_version = version
        try:
            save(state_dir, state)
        except BaseException:
            state.uploaded.update(released)
            state.skip_retry_version = previous
            raise
    return len(released)


__all__ = ["ENGINE_RETRY_REASONS", "release_engine_skips"]
