"""Find the user's StarCraft II Replays directory.

SC2 stores replays under
    Documents\\StarCraft II\\Accounts\\<account_id>\\<toon_id>\\Replays\\Multiplayer
Possible Documents locations on Windows: regular profile, OneDrive,
or a redirected Pictures\\Documents path. We probe all of them.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator, List, Optional


def candidate_documents_dirs() -> Iterator[Path]:
    """Yield plausible Documents-folder paths, in order of preference."""
    user = Path.home()
    candidates = [
        user / "Documents",
        user / "OneDrive" / "Documents",
        user / "OneDrive" / "Pictures" / "Documents",
        user / "OneDrive - Personal" / "Documents",
        # Some Windows installs redirect Documents into Pictures even
        # without OneDrive. Probe that too.
        user / "Pictures" / "Documents",
    ]
    # Also probe the registered Documents shell folder via the env-var
    # ``USERPROFILE``. Cheap and catches enterprise-managed redirects.
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        candidates.append(Path(user_profile) / "Documents")
        candidates.append(
            Path(user_profile) / "OneDrive" / "Pictures" / "Documents",
        )
    seen: set[str] = set()
    for c in candidates:
        try:
            key = str(c.resolve())
        except OSError:
            key = str(c)
        if key in seen:
            continue
        seen.add(key)
        if c.exists():
            yield c


def find_all_replays_roots() -> List[Path]:
    """Find every ``StarCraft II/Accounts`` directory we can reach.

    A user with both a regular ``Documents`` redirect AND a OneDrive
    sync sometimes ends up with replays under multiple roots (legacy
    files in one, new files in the other). Returning every match —
    rather than just the first one — lets the caller watch all of
    them so no folder gets silently ignored.
    """
    if (override := os.environ.get("SC2TOOLS_REPLAY_FOLDER")):
        p = Path(override).expanduser()
        if p.exists():
            return [p]
    out: List[Path] = []
    seen: set[str] = set()
    for docs in candidate_documents_dirs():
        sc2 = docs / "StarCraft II" / "Accounts"
        if not sc2.exists():
            continue
        try:
            key = str(sc2.resolve())
        except OSError:
            key = str(sc2)
        if key in seen:
            continue
        seen.add(key)
        out.append(sc2)
    return out


def find_replays_root() -> Optional[Path]:
    """Locate ``StarCraft II/Accounts``. Returns None if not found.

    Back-compat shim — returns the FIRST root only. Most call sites
    should prefer ``find_all_replays_roots`` so no folder is missed
    when the user has both a regular Documents and a OneDrive copy.
    """
    roots = find_all_replays_roots()
    return roots[0] if roots else None


def all_multiplayer_dirs(root: Path) -> list[Path]:
    """All <account>/<toon>/Replays/Multiplayer dirs under the root."""
    out: list[Path] = []
    for account in safe_iterdir(root):
        if not account.is_dir():
            continue
        for toon in safe_iterdir(account):
            if not toon.is_dir():
                continue
            mp = toon / "Replays" / "Multiplayer"
            if mp.exists():
                out.append(mp)
    return out


def all_multiplayer_dirs_anywhere() -> list[Path]:
    """Every Replays/Multiplayer dir found across every detected root.

    Convenience wrapper used by the GUI's Auto-detect button and the
    runner's startup discovery. The result is deduplicated by resolved
    path so a Documents folder that's also synced via OneDrive doesn't
    double-up the watch list."""
    out: list[Path] = []
    seen: set[str] = set()
    for root in find_all_replays_roots():
        for mp in all_multiplayer_dirs(root):
            try:
                key = str(mp.resolve())
            except OSError:
                key = str(mp)
            if key in seen:
                continue
            seen.add(key)
            out.append(mp)
    return out


def safe_iterdir(p: Path) -> Iterator[Path]:
    """iterdir that swallows permission errors so a single bad dir
    doesn't kill enumeration."""
    try:
        yield from p.iterdir()
    except OSError:
        return
