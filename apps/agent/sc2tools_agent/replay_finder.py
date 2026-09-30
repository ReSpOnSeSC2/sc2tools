"""Find the user's StarCraft II Replays directory.

SC2 stores replays under
    Documents\\StarCraft II\\Accounts\\<account_id>\\<toon_id>\\Replays\\Multiplayer
Possible Documents locations on Windows: regular profile, OneDrive,
or a redirected Pictures\\Documents path. We probe all of them.

A new toon folder appears whenever the player first saves a replay with a
new region or handle, e.g. ``98-S2-1-<id>`` for the Public Test realm, so
callers re-run discovery while the agent is up instead of only at startup.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Union

# Sibling ``Documents`` folders a test client could write to instead of
# ``StarCraft II``. Matching only these words keeps a user's backup copy
# ("StarCraft II - Copy") from being watched and re-parsed.
_TEST_CLIENT_WORDS = ("ptr", "test", "beta")


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
        for sc2 in _sc2_accounts_dirs(docs):
            key = path_key(sc2)
            if key in seen:
                continue
            seen.add(key)
            out.append(sc2)
    return out


def _sc2_accounts_dirs(docs: Path) -> List[Path]:
    """``StarCraft II/Accounts`` plus any test-client sibling's Accounts.

    Live and PTR clients both write to ``StarCraft II`` today (PTR toon
    handles use gateway 98). The sibling probe covers a test client that
    writes to its own ``StarCraft II PTR``-style folder instead.
    """
    out: List[Path] = []
    main = docs / "StarCraft II" / "Accounts"
    if main.exists():
        out.append(main)
    for entry in safe_iterdir(docs):
        name = entry.name.casefold()
        if not name.startswith("starcraft ii") or name == "starcraft ii":
            continue
        words = re.split(r"[^a-z0-9]+", name[len("starcraft ii"):])
        if not any(word in _TEST_CLIENT_WORDS for word in words):
            continue
        accounts = entry / "Accounts"
        if accounts.is_dir():
            out.append(accounts)
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
            key = path_key(mp)
            if key in seen:
                continue
            seen.add(key)
            out.append(mp)
    return out


def detected_replay_folders(env_folder: Optional[Path] = None) -> list[Path]:
    """Folders found without the user's help.

    ``env_folder`` (``SC2TOOLS_REPLAY_FOLDER``, used by tests and headless
    runs) replaces detection. Otherwise every ``Replays/Multiplayer`` dir,
    or, before any exists, the ``Accounts`` roots so the recursive watch
    still catches the first replay SC2 writes.
    """
    if env_folder is not None:
        return [env_folder]
    return all_multiplayer_dirs_anywhere() or find_all_replays_roots()


PathLike = Union[str, Path]


def watched_replay_folders(
    *,
    added: Iterable[PathLike] = (),
    excluded: Iterable[PathLike] = (),
    env_folder: Optional[Path] = None,
) -> list[Path]:
    """Every folder the agent should watch: detected, plus the user's.

    Detected folders come first, minus the ones the user removed in
    Settings (``excluded``); the user's own folders (``added``) follow when
    they exist. A folder inside another listed folder is dropped, since
    both the watch and the sweep are recursive and would otherwise see
    each replay twice. Detection runs on every call, so a toon folder
    created after startup is included the next time this is called.
    """
    excluded_keys = {path_key(Path(p)) for p in excluded}
    candidates = [
        p for p in detected_replay_folders(env_folder)
        if path_key(p) not in excluded_keys
    ]
    candidates += [Path(p) for p in added if Path(p).exists()]
    return drop_nested_folders(candidates)


def drop_nested_folders(folders: Iterable[Path]) -> list[Path]:
    """Keep the first of each folder, minus folders inside another one."""
    candidates = list(folders)
    keys = [path_key(p) for p in candidates]
    out: list[Path] = []
    for i, (path, key) in enumerate(zip(candidates, keys)):
        if key in keys[:i]:
            continue
        if any(is_within(key, other) for other in keys if other != key):
            continue
        out.append(path)
    return out


def path_key(p: Path) -> str:
    """Comparison key for a folder: resolved, and case-folded on Windows."""
    try:
        resolved = p.resolve()
    except OSError:
        resolved = p
    return os.path.normcase(str(resolved))


def is_within(key: str, parent_key: str) -> bool:
    """Whether ``key`` names ``parent_key`` or a folder under it."""
    if key == parent_key:
        return True
    return key.startswith(parent_key.rstrip("\\/") + os.sep)


def safe_iterdir(p: Path) -> Iterator[Path]:
    """iterdir that swallows permission errors so a single bad dir
    doesn't kill enumeration."""
    try:
        yield from p.iterdir()
    except OSError:
        return
