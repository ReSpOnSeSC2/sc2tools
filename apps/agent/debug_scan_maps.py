"""Scan every .SC2Replay in a folder and print the map_name sc2reader
returns for each one, plus a count summary at the end.

Use this to confirm whether your watched replays really do all have the
same map name (which is what's currently in the cloud DB), or whether
the agent is overwriting/discarding the real value somewhere.

Run from the agent directory (Windows):

    cd C:\\SC2TOOLS\\apps\\agent
    py debug_scan_maps.py "C:\\Users\\jay19\\OneDrive\\Pictures\\Documents\\StarCraft II\\Accounts\\50983875\\1-S2-1-267727\\Replays\\Multiplayer"

Or pass --watch to use the folder the agent is configured to watch
(reads SC2TOOLS_REPLAY_DIR from .env, falling back to your default
SC2 replay path on Windows).

Output looks like:

    [  1] 10000 Feet LE (109).SC2Replay         -> '10000 Feet LE'
    [  2] Equilibrium LE (4).SC2Replay          -> 'Equilibrium LE'
    ...
    Summary: 7 distinct map names across 128 replays
      - 10000 Feet LE       42
      - Equilibrium LE      18
      ...
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def default_watch_dir() -> Path | None:
    raw = os.environ.get("SC2TOOLS_REPLAY_DIR")
    if raw:
        return Path(raw)
    user = os.environ.get("USERPROFILE")
    if user:
        guess = Path(user) / "Documents" / "StarCraft II" / "Accounts"
        if guess.exists():
            return guess
    return None


def find_replays(root: Path) -> list[Path]:
    return sorted(root.rglob("*.SC2Replay"))


def setup_analyzer_path() -> None:
    here = Path(__file__).resolve()
    for cand in (
        here.parents[2] / "SC2Replay-Analyzer",
        here.parents[2] / "reveal-sc2-opponent-main",
    ):
        if cand.exists():
            sys.path.insert(0, str(cand))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("folder", nargs="?", help="Folder to scan recursively.")
    p.add_argument("--watch", action="store_true",
                   help="Use the configured agent watch folder.")
    p.add_argument("--limit", type=int, default=None,
                   help="Stop after this many replays (useful for huge folders).")
    args = p.parse_args()

    if args.watch or not args.folder:
        root = default_watch_dir()
        if root is None:
            print("Could not auto-detect a replay folder. Pass one as an"
                  " argument, e.g.:")
            print("  py debug_scan_maps.py \"C:\\path\\to\\Replays\\Multiplayer\"")
            return 1
    else:
        root = Path(args.folder)

    if not root.exists():
        print(f"!! Folder not found: {root}")
        return 1

    print(f"Scanning {root} ...")
    replays = find_replays(root)
    if not replays:
        print("No .SC2Replay files found.")
        return 0
    if args.limit:
        replays = replays[: args.limit]

    setup_analyzer_path()
    try:
        import sc2reader  # type: ignore
    except ImportError as exc:
        print(f"!! sc2reader not installed in this Python: {exc}")
        print("Try: py -m pip install sc2reader")
        return 1

    counts: Counter[str] = Counter()
    rows: list[tuple[str, str]] = []
    for i, path in enumerate(replays, 1):
        try:
            replay = sc2reader.load_replay(str(path), load_level=2)
            mname = getattr(replay, "map_name", None) or "<empty>"
        except Exception as exc:  # noqa: BLE001
            mname = f"<load failed: {type(exc).__name__}>"
        counts[mname] += 1
        rows.append((path.name, mname))
        print(f"[{i:>4}] {path.name:<60} -> {mname!r}")

    print()
    print(f"Summary: {len(counts)} distinct map name(s) across {len(rows)} replays")
    for name, count in counts.most_common():
        print(f"  {count:>4}  {name}")
    if len(counts) == 1 and len(rows) > 5:
        print()
        print("Every scanned replay has the same map name. If your replay")
        print("filenames clearly show different maps, sc2reader on this")
        print("machine isn't reading map_name correctly — please open an")
        print("issue with the python and sc2reader versions you have:")
        print(f"  python={sys.version_info.major}.{sys.version_info.minor}")
        try:
            print(f"  sc2reader={sc2reader.__version__}")
        except AttributeError:
            print("  sc2reader=<no __version__>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
