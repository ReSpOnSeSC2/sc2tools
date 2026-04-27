"""
Identity CLI — wizard helper.

Walks a folder of .SC2Replay files, extracts the distinct human (non-
observer, non-referee) players seen across the sample, and prints a
frequency-sorted list to stdout as JSON. Used by the first-run wizard
(Stage 2.2) to populate Step 3 ("Player identity") with the names and
SC2Pulse character ids most likely to belong to the user.

Where it lives
--------------
This is an *environment-detection* helper -- "who is this user, given
their replay folder?" -- so it sits next to ``recon_sc2_install.py``
rather than under ``SC2Replay-Analyzer/scripts/``. The replay-analytics
CLIs (``macro_cli.py``, ``buildorder_cli.py``) parse a single replay and
produce gameplay metrics; this one walks N replays and produces an
identity histogram. Different shelf.

Output contract
---------------
On success::

    {
      "ok": true,
      "scanned": 47,
      "skipped": 3,
      "folder": "C:\\\\...\\\\Multiplayer",
      "players": [
        { "name": "ReSpOnSe", "character_id": "1-S2-1-267727",
          "games_seen": 41 },
        ...
      ]
    }

On failure::

    { "ok": false, "error": "<reason>" }

The CLI exits 0 on success and 1 on failure. Single JSON object on
stdout (no newline-delimited progress) so the Node side can simply
``JSON.parse(stdout)``.

Example
-------
    python scripts/identity_cli.py \\
        --folder "C:\\\\Users\\\\jay\\\\...\\\\Replays\\\\Multiplayer" \\
        --sample-size 100
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

# How many replays to inspect by default. Big enough to be statistically
# stable, small enough to finish in <30s on a cold disk.
DEFAULT_SAMPLE_SIZE: int = 100

# Hard cap so a misconfigured client can't ask us to walk 50,000 replays
# and time out the wizard. 1000 replays at ~30ms each = ~30s ceiling.
MAX_SAMPLE_SIZE: int = 1000

REPLAY_GLOB: str = "*.SC2Replay"

# sc2reader load level. 2 is "header + details" -- enough to get the
# player roster and toon_handle without paying for full event-stream
# parsing. Faster and more robust than level 4 on slightly-damaged
# replays.
SC2READER_LOAD_LEVEL: int = 2

# Battle.net stores replays under
# ``...\StarCraft II\Accounts\<account_id>\<toon_handle>\Replays\...``
# so the user's true Battle.net account_id can be lifted directly from
# the path. The toon_handle in the path identifies which character
# *owned* the folder (the user, not the opponent), so we only attach
# an account_id to character_ids that match the path's toon.
import re as _re
ACCOUNT_PATH_RE = _re.compile(
    r"Accounts[\\/](\d+)[\\/]([1-5]-S2-\d+-\d+)",
    _re.IGNORECASE,
)


def _err(reason: str) -> int:
    """Print a structured error to stdout and return a nonzero status.

    Example:
        return _err("folder_not_found")
    """
    json.dump({"ok": False, "error": reason}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 1


def _collect_replays(folders: List[Path], sample_size: int) -> List[Path]:
    """Return up to ``sample_size`` newest .SC2Replay files across folders.

    Sample budget is *shared* across the input folders: with 5 folders and
    sample_size=100, you get the 100 globally-newest replays, not 100 per
    folder. Newest-first because a wizard run on day 0 is more likely to
    find the *current* identity than one from three years ago.

    Example:
        paths = _collect_replays(
            [Path("/.../1-Multiplayer"), Path("/.../2-Multiplayer")], 100)
    """
    candidates: List[Path] = []
    for folder in folders:
        if not folder.exists() or not folder.is_dir():
            continue
        for entry in folder.glob(REPLAY_GLOB):
            if entry.is_file():
                candidates.append(entry)
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[:sample_size]


# Race code that sc2reader exposes on player.play_race (the displayed
# race, post-pick) and the canonical name we surface back to the wizard.
RACE_NORMALIZE: Dict[str, str] = {
    "Protoss": "Protoss", "Zerg": "Zerg", "Terran": "Terran",
    "Random": "Random",
    # Some replays come back with single-letter codes from sc2reader.
    "P": "Protoss", "Z": "Zerg", "T": "Terran", "R": "Random",
}


def _extract_humans(replay) -> Iterator[Tuple[str, str, str]]:
    """Yield (name, toon_handle, race) for each non-observer human player.

    sc2reader's ``toon_handle`` matches SC2Pulse's character_id format
    (``"1-S2-1-267727"``). ``play_race`` is the picked race for the
    match; for Random players this is the actual race they were
    assigned post-pick. ``pick_race`` (when available) is what they
    *chose* (Random or a specific race) -- we prefer that so a Random
    player with 100 games shows as Random rather than fragmented across
    all three races.

    Example:
        for name, cid, race in _extract_humans(replay):
            ...
    """
    for player in getattr(replay, "players", []) or []:
        if not getattr(player, "is_human", True):
            continue
        if getattr(player, "is_observer", False):
            continue
        if getattr(player, "is_referee", False):
            continue
        name = (getattr(player, "name", "") or "").strip()
        handle = (getattr(player, "toon_handle", "") or "").strip()
        if not name or not handle:
            continue
        raw_race = (getattr(player, "pick_race", None)
                    or getattr(player, "play_race", "") or "").strip()
        race = RACE_NORMALIZE.get(raw_race, "")
        yield name, handle, race


def _scan_one(path: Path) -> Optional[List[Tuple[str, str, str]]]:
    """Return the (name, character_id, race) tuples found in one replay.

    Returns None when the replay can't be parsed; the caller treats that
    as a "skipped" tally rather than a hard error.
    """
    try:
        import sc2reader  # type: ignore
        replay = sc2reader.load_replay(str(path), load_level=SC2READER_LOAD_LEVEL)
    except Exception:
        return None
    return list(_extract_humans(replay))


def _path_owner(path: Path) -> Tuple[Optional[str], Optional[str]]:
    """Return (account_id, toon_handle) lifted from the replay's
    folder path, or ``(None, None)`` if the path doesn't match the
    Battle.net layout. The owner is the user, not the opponent --
    Battle.net stores replays under the user's account/character.

    Example:
        _path_owner(Path(r"C:\\...\\Accounts\\50983875"
                         r"\\1-S2-1-267727\\Replays\\Multiplayer"
                         r"\\file.SC2Replay"))
        -> ("50983875", "1-S2-1-267727")
    """
    m = ACCOUNT_PATH_RE.search(str(path))
    if not m:
        return None, None
    return m.group(1), m.group(2)


def _aggregate(paths: List[Path]) -> Tuple[Dict[str, dict], int, int]:
    """Walk each replay; tally per-character_id occurrences and races.

    Returns (table, scanned, skipped) where ``table`` is keyed by
    character_id and each value is::

        { "name": str, "games_seen": int, "account_id": Optional[str],
          "races": { "Protoss": int, "Terran": int,
                     "Zerg": int, "Random": int } }

    A name shown in multiple replays for the same handle wins by
    recency (last seen). Races with zero games are still emitted so
    the UI can render a stable column set. ``account_id`` is set only
    for character_ids that match a replay's owning folder path.
    """
    counts: Counter = Counter()
    name_for_id: Dict[str, str] = {}
    race_counts: Dict[str, Counter] = {}
    account_for_id: Dict[str, str] = {}
    scanned = 0
    skipped = 0
    for path in paths:
        rows = _scan_one(path)
        if rows is None:
            skipped += 1
            continue
        scanned += 1
        owner_acct, owner_toon = _path_owner(path)
        for name, char_id, race in rows:
            counts[char_id] += 1
            name_for_id[char_id] = name
            bucket = race_counts.setdefault(char_id, Counter())
            if race:
                bucket[race] += 1
            if owner_acct and owner_toon and char_id == owner_toon:
                # Only the folder owner gets an account_id; opponents
                # appear in the replay but we don't know their ids.
                account_for_id[char_id] = owner_acct
    table: Dict[str, dict] = {}
    for cid in counts:
        rc = race_counts.get(cid, Counter())
        table[cid] = {
            "name": name_for_id[cid],
            "games_seen": int(counts[cid]),
            "account_id": account_for_id.get(cid),
            "races": {
                "Protoss": int(rc.get("Protoss", 0)),
                "Terran":  int(rc.get("Terran", 0)),
                "Zerg":    int(rc.get("Zerg", 0)),
                "Random":  int(rc.get("Random", 0)),
            },
        }
    return table, scanned, skipped


def _to_payload(folders: List[Path], table: Dict[str, dict],
                scanned: int, skipped: int) -> Dict:
    """Shape the success JSON. Players are sorted games_seen DESC, name."""
    rows = [
        {
            "name": v["name"],
            "character_id": cid,
            "account_id": v.get("account_id"),
            "games_seen": int(v["games_seen"]),
            "races": v["races"],
        }
        for cid, v in table.items()
    ]
    rows.sort(key=lambda r: (-r["games_seen"], r["name"].lower()))
    return {
        "ok": True,
        "folders": [str(p) for p in folders],
        "scanned": scanned,
        "skipped": skipped,
        "players": rows,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scan replays for identity.")
    parser.add_argument("--folder", action="append", required=True,
                        dest="folders",
                        help="Multiplayer replay folder to scan. Pass repeatedly "
                             "for multiple folders (e.g. multi-region accounts).")
    parser.add_argument("--sample-size", type=int, default=DEFAULT_SAMPLE_SIZE,
                        help=f"Max replays to inspect (1..{MAX_SAMPLE_SIZE}).")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    raw_folders = args.folders or []
    folders: List[Path] = []
    for f in raw_folders:
        p = Path(f).expanduser()
        if not p.exists():
            return _err("folder_not_found")
        if not p.is_dir():
            return _err("folder_not_directory")
        folders.append(p)
    if not folders:
        return _err("folder_required")
    sample = max(1, min(MAX_SAMPLE_SIZE, int(args.sample_size)))
    paths = _collect_replays(folders, sample)
    if not paths:
        return _err("no_replays_found")
    table, scanned, skipped = _aggregate(paths)
    if not table:
        return _err("no_human_players_found")
    payload = _to_payload(folders, table, scanned, skipped)
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
