"""Find the user's StarCraft II Replays directory.

SC2 stores replays under
    Documents\\StarCraft II\\Accounts\\<account_id>\\<toon_id>\\Replays\\Multiplayer
Possible Documents locations on Windows: regular profile, OneDrive,
or a redirected Pictures\\Documents path. We probe all of them.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator, Optional


def candidate_documents_dirs() -> Iterator[Path]:
    """Yield plausible Documents-folder paths, in order of preference."""
    user = Path.home()
    candidates = [
        user / "Documents",
        user / "OneDrive" / "Documents",
        user / "OneDrive" / "Pictures" / "Documents",
        user / "OneDrive - Personal" / "Documents",
    ]
    for c in candidates:
        if c.exists():
            yield c


def find_replays_root() -> Optional[Path]:
    """Locate ``StarCraft II/Accounts``. Returns None if not found."""
    if (override := os.environ.get("SC2TOOLS_REPLAY_FOLDER")):
        p = Path(override).expanduser()
        if p.exists():
            return p
    for docs in candidate_documents_dirs():
        sc2 = docs / "StarCraft II" / "Accounts"
        if sc2.exists():
            return sc2
    return None


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


def safe_iterdir(p: Path) -> Iterator[Path]:
    """iterdir that swallows permission errors so a single bad dir
    doesn't kill enumeration."""
    try:
        yield from p.iterdir()
    except OSError:
        return
