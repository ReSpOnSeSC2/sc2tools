"""Tests for ``watcher._walk_replays`` ordering.

The full ``ReplayWatcher`` class needs a real ``UploadQueue`` and
filesystem observer to drive end-to-end. Here we lock down the
small helper that decides what order replays get processed in:
mtime-descending, so a user with 12,000+ files sees their most
recent games upload first instead of grinding through every
alphabetically-first map.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import List

from sc2tools_agent.watcher import _walk_replays


def _touch(path: Path, mtime: float) -> None:
    path.write_bytes(b"")
    os.utime(path, (mtime, mtime))


def test_walk_replays_yields_newest_first(tmp_path: Path) -> None:
    """Older 10000-Feet replays must NOT block newer Acid-Plant ones."""
    multiplayer = tmp_path / "Replays" / "Multiplayer"
    multiplayer.mkdir(parents=True)

    now = time.time()
    # Three "10000 Feet LE" replays from a year ago — these would
    # come first under naive os.walk + alphabetical order.
    old_a = multiplayer / "10000 Feet LE (1).SC2Replay"
    old_b = multiplayer / "10000 Feet LE (2).SC2Replay"
    old_c = multiplayer / "10000 Feet LE (3).SC2Replay"
    _touch(old_a, now - 86400 * 365)
    _touch(old_b, now - 86400 * 364)
    _touch(old_c, now - 86400 * 363)

    # Two recent replays on a different map. Names sort AFTER "1"
    # so under the broken behaviour they'd be processed last.
    new_a = multiplayer / "Acid Plant LE (10).SC2Replay"
    new_b = multiplayer / "Old Republic LE (3).SC2Replay"
    _touch(new_a, now - 60)
    _touch(new_b, now - 10)

    out: List[Path] = list(_walk_replays(tmp_path))
    # Newest first: Old Republic, Acid Plant, then the year-old set.
    assert out[0].name == "Old Republic LE (3).SC2Replay"
    assert out[1].name == "Acid Plant LE (10).SC2Replay"
    # The three "10000 Feet" entries trail at the back.
    tail_names = {p.name for p in out[-3:]}
    assert tail_names == {
        "10000 Feet LE (1).SC2Replay",
        "10000 Feet LE (2).SC2Replay",
        "10000 Feet LE (3).SC2Replay",
    }


def test_walk_replays_ignores_non_replay_files(tmp_path: Path) -> None:
    """Adjacent .txt / .json / .bak files must not appear in the sweep."""
    folder = tmp_path / "Multiplayer"
    folder.mkdir()
    keep = folder / "X.SC2Replay"
    drop_txt = folder / "notes.txt"
    drop_bak = folder / "X.SC2Replay.bak"
    for p in (keep, drop_txt, drop_bak):
        p.write_bytes(b"")

    out = [p.name for p in _walk_replays(tmp_path)]
    assert out == ["X.SC2Replay"]


def test_walk_replays_handles_missing_root(tmp_path: Path) -> None:
    """A non-existent root yields nothing — never raises."""
    missing = tmp_path / "does_not_exist"
    assert list(_walk_replays(missing)) == []


def test_walk_replays_recurses_into_subdirs(tmp_path: Path) -> None:
    """SC2 layouts sometimes nest Multiplayer under per-toon dirs;
    the parent watch must recurse to catch them."""
    deep = tmp_path / "Accounts" / "111" / "1-S2-1-2" / "Replays" / "Multiplayer"
    deep.mkdir(parents=True)
    p = deep / "Game.SC2Replay"
    _touch(p, time.time())

    out = list(_walk_replays(tmp_path))
    assert out == [p]
