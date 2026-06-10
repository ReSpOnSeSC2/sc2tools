"""Benchmark the build classifier against a folder of real replays.

Walks every ``.SC2Replay`` under a directory, classifies BOTH players'
openings with the shared perspective-agnostic classifier
(``core.strategy_detector_race.classify_by_race`` — the same code path
the agent, the bulk importer, and the opponent detector use), and
prints a per-matchup label histogram plus the share of games landing on
a SPECIFIC matchup-prefixed label vs the generic race tree vs the
composition fallback.

This is the Stage-8 acceptance harness (docs/MASTER_ROADMAP.md): a
matchup passes when >= 60% of a ~50-replay sample lands on a specific
label. Use it after touching the detection trees in
``core.strategy_detector_matchups`` to verify thresholds against real
ladder games rather than synthetic fixtures.

Usage:
    python scripts/benchmark_builds_cli.py <replay_dir> [--limit N]
        [--matchup ZvP] [--verbose]

Each replay contributes up to TWO samples (one per player perspective),
so 25 ZvP replays already yield ~50 Zerg-side + ~50 Protoss-side data
points for that matchup.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.event_extractor import extract_events  # noqa: E402
from core.replay_loader import load_replay_with_fallback  # noqa: E402
from core.strategy_detector_base import BaseStrategyDetector  # noqa: E402
from core.strategy_detector_helpers import (  # noqa: E402
    GAME_TOO_SHORT_THRESHOLD_SECONDS,
    _RACE_LETTER,
)
from core.strategy_detector_race import classify_by_race  # noqa: E402

ACCEPTANCE_SPECIFIC_SHARE = 0.60


def _matchup_key(my_race: str, opp_race: str) -> str:
    return (
        f"{_RACE_LETTER.get(my_race, '?')}v{_RACE_LETTER.get(opp_race, '?')}"
    )


def _bucket(label: str, matchup: str, race: str) -> str:
    """Sort a label into specific / generic / fallback / too-short."""
    if label.endswith("Game Too Short"):
        return "too_short"
    if label.startswith(f"{matchup} - "):
        return "specific"
    if label.startswith(f"{race} - "):
        if "Comp" in label or "Unclassified" in label or "Standard Play" in label:
            return "fallback"
        return "generic"
    return "fallback"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("replay_dir", help="Directory to walk for .SC2Replay files")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N replays")
    ap.add_argument(
        "--matchup",
        default=None,
        help="Only report one matchup (e.g. ZvP). Both perspectives still run.",
    )
    ap.add_argument(
        "--verbose",
        action="store_true",
        help="Print one line per classified perspective",
    )
    args = ap.parse_args()

    root = Path(args.replay_dir)
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2

    det = BaseStrategyDetector(custom_builds=[])
    histograms: dict[str, Counter] = defaultdict(Counter)
    buckets: dict[str, Counter] = defaultdict(Counter)
    parsed = 0
    failed = 0
    skipped = 0

    files = sorted(root.rglob("*.SC2Replay"))
    if args.limit:
        files = files[: args.limit]
    print(f"benchmarking {len(files)} replays under {root}\n")

    for path in files:
        try:
            replay = load_replay_with_fallback(str(path))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            if args.verbose:
                print(f"  parse_failed {path.name}: {exc}")
            continue
        players = [
            p for p in getattr(replay, "players", [])
            if not getattr(p, "is_observer", False)
            and not getattr(p, "is_referee", False)
        ]
        if len(players) != 2 or any(
            not getattr(p, "is_human", True) for p in players
        ):
            skipped += 1
            continue
        gl = getattr(replay, "game_length", None)
        if gl and gl.seconds < GAME_TOO_SHORT_THRESHOLD_SECONDS:
            skipped += 1
            continue
        parsed += 1
        for me, opp in ((players[0], players[1]), (players[1], players[0])):
            my_race = getattr(me, "play_race", "") or ""
            opp_race = getattr(opp, "play_race", "") or ""
            if my_race not in _RACE_LETTER or opp_race not in _RACE_LETTER:
                continue
            try:
                my_events, _opp_events, _stats = extract_events(replay, me.pid)
                label = classify_by_race(
                    my_race, my_events, det, opp_race=opp_race,
                )
            except Exception as exc:  # noqa: BLE001
                if args.verbose:
                    print(f"  classify_failed {path.name} pid={me.pid}: {exc}")
                continue
            matchup = _matchup_key(my_race, opp_race)
            histograms[matchup][label] += 1
            buckets[matchup][_bucket(label, matchup, my_race)] += 1
            if args.verbose:
                print(f"  {matchup} {path.name} [{me.name}] -> {label}")

    print(
        f"\nparsed={parsed} parse_failed={failed} "
        f"skipped(non-1v1/AI/too-short)={skipped}\n",
    )

    overall_pass = True
    for matchup in sorted(histograms):
        if args.matchup and matchup != args.matchup:
            continue
        total = sum(histograms[matchup].values())
        specific = buckets[matchup]["specific"]
        share = specific / total if total else 0.0
        verdict = "PASS" if share >= ACCEPTANCE_SPECIFIC_SHARE else "FAIL"
        if share < ACCEPTANCE_SPECIFIC_SHARE:
            overall_pass = False
        print(f"== {matchup}  n={total}  specific={share:.0%}  [{verdict}]")
        for kind in ("specific", "generic", "fallback", "too_short"):
            n = buckets[matchup][kind]
            if n:
                print(f"   {kind:>9}: {n} ({n / total:.0%})")
        for label, n in histograms[matchup].most_common():
            print(f"     {n:4d}  {label}")
        print()

    print(
        "acceptance: >= "
        f"{ACCEPTANCE_SPECIFIC_SHARE:.0%} specific per matchup -> "
        + ("PASS" if overall_pass else "FAIL"),
    )
    return 0 if overall_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
