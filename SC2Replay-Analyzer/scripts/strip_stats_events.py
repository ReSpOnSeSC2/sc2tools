"""One-shot migration: strip bulky arrays out of meta_database.json blobs.

Why this exists
---------------
``macro_breakdown.stats_events`` (and its siblings ``opp_stats_events``
and ``unit_timeline``) used to be persisted into every game record so
the SPA could render the macro chart without re-spawning Python. Each
of those arrays is 60-150 sample dicts × ~10 fields. Across thousands
of games the JSON file grew past **Node's 0x1fffffe8 (~536 MB) max
string length**, which made ``fs.readFileSync(path, 'utf8')`` start
failing with::

    [Analyzer] failed to reload meta:
        Cannot create a string longer than 0x1fffffe8 characters

Both fields are now recomputed on demand by ``/macro-breakdown``, so we
do not need them on disk. This script removes them from the existing DB
and writes back atomically.

Usage::

    python scripts/strip_stats_events.py PATH/TO/meta_database.json

Exit codes: 0 on success, 1 on usage error, 2 on runtime error.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, Tuple

# Fields we strip from every macro_breakdown blob. They get recomputed
# fresh by analyzer.js POST /games/:id/macro-breakdown when needed.
STRIP_FIELDS = ("stats_events", "opp_stats_events", "unit_timeline")


def _human_bytes(n: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    f = float(n)
    for u in units:
        if f < 1024 or u == "GB":
            return f"{f:.1f} {u}"
        f /= 1024
    return f"{f:.1f} GB"


def _strip_breakdown(bd: Any) -> Tuple[bool, int]:
    """Return (changed, fields_removed) for one macro_breakdown dict."""
    if not isinstance(bd, dict):
        return False, 0
    removed = 0
    for k in STRIP_FIELDS:
        if k in bd:
            del bd[k]
            removed += 1
    return removed > 0, removed


def _walk_and_strip(db: Dict[str, Any]) -> Dict[str, int]:
    """Mutate db in place, return counts."""
    counts = {
        "builds": 0,
        "games": 0,
        "games_changed": 0,
        "fields_removed": 0,
    }
    for build_name, bd in db.items():
        if not isinstance(bd, dict):
            continue
        counts["builds"] += 1
        for game in bd.get("games", []) or []:
            counts["games"] += 1
            mb = game.get("macro_breakdown")
            changed, removed = _strip_breakdown(mb)
            if changed:
                counts["games_changed"] += 1
                counts["fields_removed"] += removed
    return counts


def _atomic_write(db_path: str, db: Dict[str, Any]) -> None:
    tmp = db_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        # default separators keep file slightly smaller than indent=2 but
        # we keep indent for human inspection. Net win is still huge.
        json.dump(db, f, indent=2, default=str, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, db_path)


def main(argv) -> int:
    if len(argv) != 2:
        print("usage: strip_stats_events.py PATH/TO/meta_database.json",
              file=sys.stderr)
        return 1
    path = argv[1]
    if not os.path.isfile(path):
        print(f"file not found: {path}", file=sys.stderr)
        return 1
    before = os.path.getsize(path)
    print(f"[migrate] reading {path}")
    print(f"[migrate] size before: {_human_bytes(before)} ({before} bytes)")
    t0 = time.monotonic()
    try:
        with open(path, "r", encoding="utf-8") as f:
            db = json.load(f)
    except MemoryError:
        print("[migrate] OUT OF MEMORY loading the file. Install ijson "
              "(`pip install ijson`) and re-run with --streaming "
              "(not yet implemented).", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"[migrate] parse failed: {exc}", file=sys.stderr)
        return 2
    print(f"[migrate] parsed in {time.monotonic() - t0:.1f}s")
    counts = _walk_and_strip(db)
    print(f"[migrate] builds={counts['builds']} games={counts['games']} "
          f"games_changed={counts['games_changed']} "
          f"fields_removed={counts['fields_removed']}")
    if counts["games_changed"] == 0:
        print("[migrate] nothing to strip; file already slim. exiting.")
        return 0
    print(f"[migrate] writing back atomically...")
    t1 = time.monotonic()
    try:
        _atomic_write(path, db)
    except Exception as exc:
        print(f"[migrate] write failed: {exc}", file=sys.stderr)
        return 2
    after = os.path.getsize(path)
    print(f"[migrate] wrote in {time.monotonic() - t1:.1f}s")
    print(f"[migrate] size after:  {_human_bytes(after)} ({after} bytes)")
    print(f"[migrate] reduction:   {_human_bytes(before - after)} "
          f"({(1 - after / max(1, before)) * 100:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
