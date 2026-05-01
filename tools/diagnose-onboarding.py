"""Diagnose the SC2 Tools onboarding "no_human_players_found" failure.

Self-contained: needs only Python 3.10+ and ``sc2reader`` (the latter
ships with the SC2 Tools install). Walks the standard SC2 replay-folder
patterns the first-run wizard uses, picks the folder with the most
replays, tries to parse the newest few with ``sc2reader``, and writes a
plain-text report to ``diagnose.txt`` next to this script.

Why this script exists
----------------------
The wizard''s Step 3 collapses every failure mode into the same opaque
``no_human_players_found`` string. This tool surfaces the underlying
cause -- sc2reader missing, sc2reader exception on every replay, only
vs-AI replays present, wrong folder picked, etc. -- so a non-developer
user can paste the report back to support and get an answer.

Usage:
    Double-click ``diagnose-onboarding.bat`` next to this file. It opens
    a console, runs this script, opens the report in Notepad, and
    leaves ``diagnose.txt`` on disk for emailing back.

The script never modifies any state. It only reads.
"""
from __future__ import annotations

import os
import platform
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------

# Replay discovery is layered. Most users hit one of the wizard''s known
# patterns (OneDrive / Documents / mac); a smaller group has redirected
# their Documents to a non-default drive. We try cheap patterns first,
# then fall back to a bounded recursive search rooted at common drive
# letters. The friend can also drag-drop their Multiplayer folder onto
# the .bat -- that path arrives as ``sys.argv[1]`` and short-circuits
# all auto-discovery.
#
# The CANONICAL_SUFFIX is the part of the path that''s identical for
# every Battle.net install since 2010. The ``*``s are account_id and
# toon_handle.
_CANONICAL_SUFFIX: List[str] = [
    "StarCraft II", "Accounts", "*", "*", "Replays", "Multiplayer",
]

# Cheap, fast roots to try first. ``Path.home()`` is the *current*
# user''s profile dir, which works regardless of name. We add common
# Documents-redirect targets (OneDrive, Dropbox, Google Drive, iCloud)
# so a redirected Documents folder still hits a cheap pattern.
def _quick_roots() -> List[Path]:
    """Cheap candidate roots to expand the canonical suffix from."""
    home = Path.home()
    roots: List[Path] = [
        home,
        home / "Documents",
        home / "OneDrive",
        home / "OneDrive" / "Documents",
        home / "OneDrive" / "Pictures" / "Documents",
        home / "Dropbox",
        home / "Google Drive",
        home / "iCloudDrive",
        home / "iCloud Drive",
        home / "Box",
        home / "Library" / "Application Support" / "Blizzard",  # mac
    ]
    # OneDrive can also live at a corporate / business path with a
    # company name in the folder. Pick up any home child that begins
    # with "OneDrive".
    try:
        for child in home.iterdir():
            if child.is_dir() and child.name.lower().startswith("onedrive"):
                roots.append(child)
                roots.append(child / "Documents")
                roots.append(child / "Pictures" / "Documents")
    except (OSError, PermissionError):
        pass
    # Public Documents is sometimes used for shared accounts.
    public_docs = Path("C:/Users/Public/Documents")
    if public_docs.is_dir():
        roots.append(public_docs)
    return roots


# Drive roots to scan when the cheap patterns turn up nothing. We cap
# the recursive walk so we never traverse a whole drive -- look for
# ``StarCraft II`` and only descend into matches.
def _drive_roots() -> List[Path]:
    """Return existing drive-letter roots on Windows, ``[]`` elsewhere."""
    if os.name != "nt":
        return []
    out: List[Path] = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        p = Path(f"{letter}:/")
        if p.exists():
            out.append(p)
    return out


_REPLAY_GLOB: str = "*.SC2Replay"
_SC2READER_LOAD_LEVEL: int = 2  # matches identity_cli.py
_SAMPLE_PARSE_COUNT: int = 5    # newest N replays
_REPORT_FILENAME: str = "diagnose.txt"

# Bounded recursive search: don''t descend deeper than this when looking
# for ``StarCraft II`` directories under drive roots. 4 covers
# ``D:/Games/StarCraft II``, ``E:/Documents/whatever/StarCraft II``,
# typical Steam-style ``D:/SteamLibrary/.../StarCraft II``.
_DRIVE_SEARCH_MAX_DEPTH: int = 4

# Skip well-known noisy directories during the drive walk -- avoids
# endless time in ``Windows``, ``$Recycle.Bin``, ``System Volume
# Information``, package caches, etc.
_DRIVE_SKIP_NAMES: frozenset = frozenset({
    "windows", "$recycle.bin", "system volume information",
    "programdata", "appdata", "perflogs", "msocache", "config.msi",
    "node_modules", ".git", "intel", "amd", "nvidia",
})


# ---------------------------------------------------------------------
# Folder discovery
# ---------------------------------------------------------------------

def _expand_glob(base: Path, segments: List[str]) -> List[Path]:
    """Walk ``segments`` from ``base``; return existing dirs.

    Each ``*`` segment expands to all immediate subdirectories. Bounded
    walk -- depth is fixed at ``len(segments)``.
    """
    frontier: List[Path] = [base]
    for seg in segments:
        nxt: List[Path] = []
        for d in frontier:
            if not d.is_dir():
                continue
            if seg == "*":
                try:
                    nxt.extend(p for p in d.iterdir() if p.is_dir())
                except (OSError, PermissionError):
                    pass
            else:
                child = d / seg
                if child.is_dir():
                    nxt.append(child)
        frontier = nxt
        if not frontier:
            return []
    return frontier


def _walk_for_starcraft_ii(root: Path, max_depth: int) -> List[Path]:
    """Bounded BFS for directories literally named ``StarCraft II``.

    Skips system / cache directories that never contain replays. Used
    only as a fallback when the cheap roots miss.
    """
    found: List[Path] = []
    if not root.is_dir():
        return found
    frontier: List[Tuple[Path, int]] = [(root, 0)]
    while frontier:
        current, depth = frontier.pop(0)
        if depth > max_depth:
            continue
        try:
            entries = list(current.iterdir())
        except (OSError, PermissionError):
            continue
        for entry in entries:
            if not entry.is_dir():
                continue
            name_lower = entry.name.lower()
            if name_lower in _DRIVE_SKIP_NAMES:
                continue
            if entry.name == "StarCraft II":
                # Confirm it has Accounts under it (rules out install dirs).
                if (entry / "Accounts").is_dir():
                    found.append(entry)
                # Don''t descend further; replays are NOT inside another
                # StarCraft II directory.
                continue
            if depth + 1 <= max_depth:
                frontier.append((entry, depth + 1))
    return found


def _expand_from_sc2_root(sc2_root: Path) -> List[Path]:
    """From a ``StarCraft II`` directory, return its Multiplayer folders."""
    return _expand_glob(sc2_root, _CANONICAL_SUFFIX[1:])


def find_replay_folders(override: Optional[Path] = None) -> List[Path]:
    """Return every Multiplayer folder discovered.

    Strategy:
      1. If ``override`` is provided (e.g. dragged onto the .bat), use it
         directly (fall through to the parent SC2 dir if it''s further
         up the tree than Multiplayer).
      2. Try every quick root with the canonical suffix.
      3. If still empty, walk drive letters bounded by depth.
    """
    found: List[Path] = []
    seen: set = set()

    def add(path: Path) -> None:
        key = str(path).lower()
        if key not in seen and path.is_dir():
            seen.add(key)
            found.append(path)

    if override is not None and override.is_dir():
        # User-supplied path. It might be the Multiplayer folder itself,
        # an account/toon folder, an Accounts folder, or the StarCraft II
        # root. Try each interpretation in order.
        if override.name == "Multiplayer":
            add(override)
        else:
            # Walk down up to canonical depth looking for Multiplayer.
            for path in _expand_glob(override, _CANONICAL_SUFFIX[1:]):
                add(path)
            for child in override.rglob("Multiplayer"):
                if "Replays" in child.parts and child.is_dir():
                    add(child)

    # Quick roots
    for root in _quick_roots():
        for path in _expand_glob(root, _CANONICAL_SUFFIX):
            add(path)
        # Also accept a "StarCraft II" directly under the root.
        sc2 = root / "StarCraft II"
        for path in _expand_from_sc2_root(sc2):
            add(path)

    if found:
        return found

    # Fallback: bounded drive walk for "StarCraft II" folders.
    for drive in _drive_roots():
        for sc2_root in _walk_for_starcraft_ii(drive, _DRIVE_SEARCH_MAX_DEPTH):
            for path in _expand_from_sc2_root(sc2_root):
                add(path)
    return found


def count_replays(folder: Path) -> int:
    """Return number of ``.SC2Replay`` files at the top level of ``folder``."""
    try:
        return sum(1 for p in folder.glob(_REPLAY_GLOB) if p.is_file())
    except (OSError, PermissionError):
        return 0


def newest_replays(folder: Path, n: int) -> List[Path]:
    """Return the ``n`` newest replays in ``folder`` by mtime."""
    try:
        files = [p for p in folder.glob(_REPLAY_GLOB) if p.is_file()]
    except (OSError, PermissionError):
        return []
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:n]


# ---------------------------------------------------------------------
# Replay parsing
# ---------------------------------------------------------------------

def probe_sc2reader() -> Tuple[bool, str]:
    """Return (ok, version_or_error) for ``import sc2reader``."""
    try:
        import sc2reader  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover -- diagnostic
        return False, f"{type(exc).__name__}: {exc}"
    return True, getattr(sc2reader, "__version__", "unknown")


def parse_one(path: Path) -> Dict[str, Any]:
    """Try to parse ``path``. Return a structured outcome dict."""
    out: Dict[str, Any] = {"file": path.name, "ok": False}
    try:
        import sc2reader  # type: ignore[import-not-found]
        replay = sc2reader.load_replay(str(path),
                                       load_level=_SC2READER_LOAD_LEVEL)
    except Exception as exc:
        out["error_type"] = type(exc).__name__
        out["error_message"] = str(exc)[:240]
        return out
    humans, ai_count, observers = 0, 0, 0
    try:
        for player in getattr(replay, "players", []) or []:
            if getattr(player, "is_observer", False):
                observers += 1
                continue
            if getattr(player, "is_referee", False):
                observers += 1
                continue
            if getattr(player, "is_human", True):
                humans += 1
            else:
                ai_count += 1
    except Exception as exc:  # pragma: no cover -- defensive
        out["error_type"] = type(exc).__name__
        out["error_message"] = f"player walk failed: {exc}"[:240]
        return out
    out["ok"] = True
    out["humans"] = humans
    out["ai_players"] = ai_count
    out["observers"] = observers
    out["build"] = getattr(replay, "build", None)
    out["release"] = getattr(replay, "release_string", None)
    return out


# ---------------------------------------------------------------------
# Report shaping
# ---------------------------------------------------------------------

def diagnose(folder_results: List[Dict[str, Any]],
             sc2reader_ok: bool) -> str:
    """Return a one-line verdict string based on aggregate results."""
    if not folder_results:
        return ("VERDICT: No SC2 replay folder found under your home "
                "directory. Make sure StarCraft II has been launched at "
                "least once and that you have played at least one "
                "Multiplayer game.")
    best = max(folder_results, key=lambda r: r["replay_count"])
    if best["replay_count"] == 0:
        return ("VERDICT: Replay folder(s) exist but contain no "
                ".SC2Replay files. Play at least one Multiplayer game "
                "in StarCraft II, then re-run this diagnostic.")
    samples = best.get("samples") or []
    if not samples:
        return ("VERDICT: Replays exist but no sample was parsed. "
                "Re-run the diagnostic.")
    failed = [s for s in samples if not s.get("ok")]
    if not sc2reader_ok:
        return ("VERDICT: sc2reader is not installed in the Python "
                "interpreter on PATH. Run: pip install sc2reader==1.8.0")
    if len(failed) == len(samples):
        first = failed[0]
        return (f"VERDICT: Every sampled replay failed to parse with "
                f"{first.get('error_type')}: "
                f"{first.get('error_message')}. Likely cause: sc2reader "
                f"version too old for current SC2 patch. Try: "
                f"pip install --upgrade sc2reader")
    parsed = [s for s in samples if s.get("ok")]
    has_humans = any(s.get("humans", 0) >= 2 for s in parsed)
    if not has_humans:
        ai_only = all((s.get("ai_players", 0) > 0 and s.get("humans", 0) <= 1)
                      for s in parsed)
        if ai_only:
            return ("VERDICT: Replays parsed fine but contain only "
                    "vs-AI matches (no second human player). The wizard "
                    "needs at least one ladder/custom-game replay with "
                    "two human players. Play one ranked game and re-run.")
        return ("VERDICT: Replays parsed but no human players were "
                "found. Unusual -- send this report to support.")
    return ("VERDICT: Replays parse OK and contain humans. The wizard "
            "should not be returning no_human_players_found. Likely a "
            "Python-version mismatch between the bundled launcher and "
            "the Python on PATH. Send this report to support.")


def render_report(now: datetime, folders: List[Path],
                  folder_results: List[Dict[str, Any]],
                  sc2reader_status: Tuple[bool, str],
                  verdict: str) -> str:
    """Build the plain-text diagnostic report."""
    lines: List[str] = []
    lines.append("SC2 Tools onboarding diagnostic report")
    lines.append("=" * 60)
    lines.append(f"Run at: {now.isoformat(timespec='seconds')}")
    lines.append(f"Host:   {platform.platform()}")
    lines.append(f"Python: {sys.version.splitlines()[0]}")
    lines.append(f"PythonExe: {sys.executable}")
    sc2_ok, sc2_info = sc2reader_status
    lines.append(f"sc2reader: {'OK ' + sc2_info if sc2_ok else 'MISSING -> ' + sc2_info}")
    lines.append("")
    lines.append(f"{verdict}")
    lines.append("")
    lines.append(f"Folders discovered: {len(folders)}")
    if not folders:
        lines.append("")
        lines.append("HINT: If your replays are in a non-standard location,")
        lines.append("close this report, then drag your Multiplayer folder")
        lines.append("(the one containing .SC2Replay files) onto")
        lines.append("diagnose-onboarding.bat to scan it directly.")
    for i, folder in enumerate(folders, 1):
        lines.append(f"  [{i}] {folder}")
    lines.append("")
    for fr in folder_results:
        lines.append(f"--- {fr['folder']}")
        lines.append(f"    .SC2Replay files: {fr['replay_count']}")
        for s in fr.get("samples") or []:
            if s.get("ok"):
                lines.append(
                    f"    OK  {s['file']:50s} "
                    f"humans={s['humans']} ai={s['ai_players']} "
                    f"observers={s['observers']} build={s.get('build')}"
                )
            else:
                lines.append(
                    f"    ERR {s['file']:50s} "
                    f"{s.get('error_type')}: {s.get('error_message')}"
                )
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    now = datetime.now()
    override: Optional[Path] = None
    if len(sys.argv) > 1 and sys.argv[1].strip():
        candidate = Path(sys.argv[1]).expanduser().resolve()
        if candidate.is_dir():
            override = candidate
            print(f"[diagnose] using user-supplied folder: {candidate}")
        else:
            print(f"[diagnose] WARNING: argv[1] is not a directory: {candidate}")
    folders = find_replay_folders(override)
    sc2reader_status = probe_sc2reader()

    folder_results: List[Dict[str, Any]] = []
    for folder in folders:
        n = count_replays(folder)
        samples: List[Dict[str, Any]] = []
        for path in newest_replays(folder, _SAMPLE_PARSE_COUNT):
            samples.append(parse_one(path))
        folder_results.append({
            "folder": str(folder),
            "replay_count": n,
            "samples": samples,
        })

    verdict = diagnose(folder_results, sc2reader_status[0])
    report = render_report(now, folders, folder_results,
                           sc2reader_status, verdict)

    here = Path(__file__).resolve().parent
    out_path = here / _REPORT_FILENAME
    try:
        out_path.write_text(report, encoding="utf-8")
        print(report)
        print()
        print(f"Report saved to: {out_path}")
    except OSError as exc:
        print(report)
        print(f"WARNING: could not write {out_path}: {exc}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # pragma: no cover -- diagnostic
        traceback.print_exc()
        sys.exit(1)
