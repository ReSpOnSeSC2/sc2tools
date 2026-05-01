"""
merge_unknown_pulse_ids.py — fold legacy ``unknown:<Name>`` Black Book
records into their numeric SC2Pulse twins.

Background
----------
When a replay arrives at watchers/replay_watcher.py before the live
overlay has resolved a SC2Pulse character ID for the opponent, the
record is keyed on ``"unknown:<Name>"``. If the live overlay later
sees the same opponent and writes a record under the real numeric
Pulse character ID, the Black Book ends up with two records for the
same person::

    "unknown:Yamada":   {"Name": "Yamada",     "Matchups": {...}}
    "340938838":        {"Name": "Yamada#622", "Matchups": {...}}

Historically this happened because ``BlackBookStore.find_by_name``
only stripped clan tags, not BattleTag discriminators (``#1234``), so
``"Yamada"`` and ``"Yamada#622"`` did not compare equal.

This script merges every ``unknown:<Name>`` record into its numeric
twin when one exists, preserving every game record (deduped by
identity) and every win/loss counter. Records without a numeric twin
are left in place unchanged.

The corresponding analyzer DB cross-links (``opp_pulse_id`` on each
game) are rewritten to the numeric ID so deep-dive lookups resolve
correctly.

Safety
------
* Atomic writes (``data_store._atomic_write_json``).
* Timestamped backup of every mutated file before any change.
* ``--dry-run`` prints the plan without touching disk.

Usage
-----
    python scripts/merge_unknown_pulse_ids.py [--dry-run]
                                              [--history PATH]
                                              [--meta PATH]
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# Allow ``python scripts/merge_unknown_pulse_ids.py`` from the repo root.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from core.data_store import (  # noqa: E402  (sys.path tweak above)
    BlackBookStore,
    _atomic_write_json,
    _read_json,
)
from core.paths import HISTORY_FILE, META_DB_FILE  # noqa: E402


UNKNOWN_PREFIX = "unknown:"


# ---------------------------------------------------------------
# Pure planning helpers (no I/O) — exported so tests can drive the
# merge logic without touching disk.
# ---------------------------------------------------------------
def build_unknown_to_numeric_map(history: Dict[str, Any]) -> Dict[str, str]:
    """
    Return ``{unknown_key: numeric_pulse_id}`` for every ``unknown:<Name>``
    record whose Name has a comparable numeric twin in ``history``.

    Comparison uses :py:meth:`BlackBookStore._name_forms`, the same set
    the live ``find_by_name`` lookup uses, so this mirrors what the
    watcher would have produced if the discriminator-aware match had
    been in place when the unknown record was first created.
    """
    numeric_records: List[Tuple[str, set]] = []
    for pulse_id, rec in history.items():
        if str(pulse_id).startswith(UNKNOWN_PREFIX):
            continue
        forms = BlackBookStore._name_forms((rec or {}).get("Name", ""))
        if forms:
            numeric_records.append((pulse_id, forms))

    out: Dict[str, str] = {}
    for pulse_id, rec in history.items():
        if not str(pulse_id).startswith(UNKNOWN_PREFIX):
            continue
        unknown_name = (rec or {}).get("Name", "") or pulse_id[len(UNKNOWN_PREFIX):]
        unknown_forms = BlackBookStore._name_forms(unknown_name)
        if not unknown_forms:
            continue
        for numeric_id, numeric_forms in numeric_records:
            if not numeric_forms.isdisjoint(unknown_forms):
                out[pulse_id] = numeric_id
                break
    return out


def merge_records_in_place(
    history: Dict[str, Any],
    plan: Dict[str, str],
) -> Dict[str, Any]:
    """
    Apply the merge ``plan`` (``{unknown_key: numeric_id}``) to
    ``history`` in place and return per-pair statistics.

    Game records are deduped by ``BlackBookStore._game_identity`` so a
    deep-parsed replay that already lives under both keys is patched,
    not double-counted. Wins/Losses for newly-appended games are
    bumped on the numeric record; identity matches do not bump
    counters (they were already counted under the unknown key, but
    the numeric record was the survivor of a separate write so its
    counters reflect only its own appended games).

    Returns a list of dicts, one per merged pair, with
    ``games_appended``, ``games_patched``, and ``wins_added`` /
    ``losses_added`` so the caller can report what changed.
    """
    stats: Dict[str, Any] = {"pairs": []}

    for unknown_key, numeric_id in plan.items():
        unknown_rec = history.get(unknown_key)
        numeric_rec = history.get(numeric_id)
        if unknown_rec is None or numeric_rec is None:
            # Defensive: plan was built from this same dict, but a
            # caller could have mutated it. Skip silently and report.
            stats["pairs"].append({
                "unknown": unknown_key,
                "numeric": numeric_id,
                "skipped": "record disappeared",
            })
            continue

        numeric_rec.setdefault("Name", unknown_rec.get("Name", ""))
        if not numeric_rec.get("Race") and unknown_rec.get("Race"):
            numeric_rec["Race"] = unknown_rec["Race"]
        if not numeric_rec.get("Notes") and unknown_rec.get("Notes"):
            numeric_rec["Notes"] = unknown_rec["Notes"]
        numeric_matchups = numeric_rec.setdefault("Matchups", {})

        appended = patched = wins_added = losses_added = 0
        for matchup, mu_data in (unknown_rec.get("Matchups") or {}).items():
            num_mu = numeric_matchups.setdefault(
                matchup, {"Wins": 0, "Losses": 0, "Games": []}
            )
            num_mu.setdefault("Wins", 0)
            num_mu.setdefault("Losses", 0)
            num_mu.setdefault("Games", [])

            existing_ids = {
                BlackBookStore._game_identity(g) for g in num_mu["Games"]
            }
            for g in mu_data.get("Games", []):
                ident = BlackBookStore._game_identity(g)
                if ident in existing_ids:
                    # Patch the existing record in place: keys present
                    # on the unknown side fill in any blanks on the
                    # numeric side without clobbering existing data.
                    for existing in num_mu["Games"]:
                        if BlackBookStore._game_identity(existing) == ident:
                            for k, v in g.items():
                                existing.setdefault(k, v)
                            break
                    patched += 1
                else:
                    num_mu["Games"].append(dict(g))
                    existing_ids.add(ident)
                    appended += 1
                    result = (g.get("Result") or "").strip()
                    if result == "Victory":
                        num_mu["Wins"] = int(num_mu.get("Wins", 0)) + 1
                        wins_added += 1
                    elif result == "Defeat":
                        num_mu["Losses"] = int(num_mu.get("Losses", 0)) + 1
                        losses_added += 1

        # Drop the unknown record now that its games are folded in.
        del history[unknown_key]

        stats["pairs"].append({
            "unknown": unknown_key,
            "numeric": numeric_id,
            "games_appended": appended,
            "games_patched": patched,
            "wins_added": wins_added,
            "losses_added": losses_added,
        })

    return stats


def rewrite_analyzer_pulse_ids(
    meta_db: Dict[str, Any],
    plan: Dict[str, str],
) -> int:
    """
    Rewrite every ``opp_pulse_id`` field in the analyzer DB whose value
    matches a merged unknown key to the corresponding numeric ID.

    Returns the number of game records mutated.
    """
    if not isinstance(meta_db, dict) or not plan:
        return 0
    rewritten = 0
    for build_name, bd in meta_db.items():
        if not isinstance(bd, dict):
            continue
        for game in bd.get("games", []) or []:
            if not isinstance(game, dict):
                continue
            current = game.get("opp_pulse_id")
            if current and current in plan:
                game["opp_pulse_id"] = plan[current]
                rewritten += 1
    return rewritten


# ---------------------------------------------------------------
# I/O wrappers
# ---------------------------------------------------------------
def _backup(path: str) -> Optional[str]:
    """Timestamped sibling backup; returns the new path, or None if absent."""
    if not os.path.exists(path):
        return None
    stamp = datetime.now().strftime("%Y%m%dT%H%M%SZ")
    dst = f"{path}.pre-merge-unknown-{stamp}"
    shutil.copy2(path, dst)
    return dst


def run_merge(
    *,
    history_path: str,
    meta_path: str,
    dry_run: bool,
    out=sys.stdout,
) -> int:
    """
    Top-level entry point. Loads, plans, optionally writes. Returns a
    Unix-style exit code (0 success, 0 nothing-to-do, non-zero on
    error). Writes a human-readable report to ``out``.
    """
    if not os.path.exists(history_path):
        print(f"[merge] Black Book not found: {history_path}", file=sys.stderr)
        return 1

    history = _read_json(history_path, {})
    if not isinstance(history, dict):
        print(f"[merge] Black Book is not a dict (got {type(history).__name__}); aborting.",
              file=sys.stderr)
        return 2

    plan = build_unknown_to_numeric_map(history)
    if not plan:
        print("[merge] no `unknown:<Name>` records have a numeric twin — nothing to do.",
              file=out)
        return 0

    print(f"[merge] {len(plan)} unknown record(s) will fold into a numeric twin:",
          file=out)
    for unknown_key, numeric_id in plan.items():
        unk_name = (history.get(unknown_key) or {}).get("Name", "")
        num_name = (history.get(numeric_id) or {}).get("Name", "")
        print(f"  {unknown_key!r:40s}  ->  {numeric_id!r:14s}  "
              f"({unk_name!r}  ->  {num_name!r})",
              file=out)

    # Plan-only: short-circuit before reading the analyzer DB.
    if dry_run:
        print("[merge] --dry-run: no files written.", file=out)
        return 0

    bb_backup = _backup(history_path)
    if bb_backup:
        print(f"[merge] backed up Black Book -> {bb_backup}", file=out)

    stats = merge_records_in_place(history, plan)
    _atomic_write_json(history_path, history)
    print(f"[merge] wrote merged Black Book -> {history_path}", file=out)

    rewritten = 0
    if os.path.exists(meta_path):
        meta = _read_json(meta_path, {})
        if isinstance(meta, dict):
            meta_backup = _backup(meta_path)
            if meta_backup:
                print(f"[merge] backed up analyzer DB -> {meta_backup}", file=out)
            rewritten = rewrite_analyzer_pulse_ids(meta, plan)
            if rewritten:
                _atomic_write_json(meta_path, meta)
                print(f"[merge] rewrote {rewritten} opp_pulse_id field(s) in {meta_path}",
                      file=out)
            else:
                print(f"[merge] no opp_pulse_id rewrites needed in {meta_path}",
                      file=out)
        else:
            print(f"[merge] analyzer DB is not a dict; skipped cross-link rewrite.",
                  file=out)
    else:
        print(f"[merge] analyzer DB not found at {meta_path}; "
              f"skipped cross-link rewrite.", file=out)

    # Summary line.
    total_appended = sum(p.get("games_appended", 0) for p in stats["pairs"])
    total_patched = sum(p.get("games_patched", 0) for p in stats["pairs"])
    total_wins = sum(p.get("wins_added", 0) for p in stats["pairs"])
    total_losses = sum(p.get("losses_added", 0) for p in stats["pairs"])
    print(
        f"[merge] done. pairs={len(plan)} "
        f"games_appended={total_appended} games_patched={total_patched} "
        f"wins_added={total_wins} losses_added={total_losses} "
        f"opp_pulse_id_rewritten={rewritten}",
        file=out,
    )
    return 0


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Merge legacy unknown:<Name> Black Book records into "
                    "their numeric SC2Pulse twins.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the merge plan without touching any files.",
    )
    p.add_argument(
        "--history",
        default=HISTORY_FILE,
        help=f"Path to MyOpponentHistory.json (default: {HISTORY_FILE}).",
    )
    p.add_argument(
        "--meta",
        default=META_DB_FILE,
        help=f"Path to meta_database.json (default: {META_DB_FILE}).",
    )
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    return run_merge(
        history_path=args.history,
        meta_path=args.meta,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
