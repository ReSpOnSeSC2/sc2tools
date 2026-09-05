"""Extract real replay evidence for the offline identity retrieval audit.

No network or account upload. Toon handles label the evaluation only and are
hashed before output. The production extractor supplies every feature. The
default sample deliberately favors repeated opponents so holdout is possible;
it is not a random population accuracy estimate.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from itertools import islice
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "agent"))
from sc2tools_agent.replay_pipeline import _compute_opponent_play_signature  # noqa: E402
import sc2reader  # noqa: E402
from core.event_extractor import build_log_lines, extract_events  # noqa: E402
from core.sc2_replay_parser import _is_resumed_replay  # noqa: E402
from core.timebase import real_game_length  # noqa: E402


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("replay_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=60, help="Maximum full event parses (2-1000)")
    parser.add_argument("--max-files", type=int, default=5000, help="Maximum metadata/header scans (2-20000)")
    args = parser.parse_args()
    if not args.replay_dir.is_dir() or not 2 <= args.limit <= 1000 or not 2 <= args.max_files <= 20000:
        parser.error("Replay directory must exist; limit 2-1000 and max-files 2-20000")

    counters: Counter[str] = Counter()
    metadata = []
    hashes = set()
    toon_counts: Counter[str] = Counter()
    paths = sorted(islice(args.replay_dir.rglob("*.SC2Replay"), args.max_files + 1))
    for index, path in enumerate(paths):
        if index >= args.max_files:
            counters["metadataScanTruncated"] = 1
            break
        counters["filesScanned"] += 1
        try:
            replay_hash = digest(path.read_bytes())
            if replay_hash in hashes:
                counters["duplicateFiles"] += 1
                continue
            hashes.add(replay_hash)
            replay = sc2reader.load_replay(str(path), load_level=2)
            players = list(replay.players)
            if len(players) != 2 or getattr(replay, "real_type", "") != "1v1" or any(
                not getattr(player, "is_human", False) for player in players
            ):
                counters["excludedNonHumanOrNon1v1"] += 1
                continue
            labels = [(str(getattr(player, "toon_handle", "") or ""), str(player.play_race)) for player in players]
            if any(not toon or race not in ("Terran", "Protoss", "Zerg") for toon, race in labels):
                counters["missingIdentityOrRace"] += 1
                continue
            toon_counts.update({toon for toon, _ in labels})
            metadata.append({"path": path, "hash": replay_hash, "labels": labels,
                             "timestamp": int(replay.unix_timestamp)})
        except Exception as exc:
            counters["metadataErrors"] += 1
            print(f"Metadata parse failed ({type(exc).__name__}): {path.name}", file=sys.stderr)
        if counters["filesScanned"] % 100 == 0:
            print(f"Metadata scanned: {counters['filesScanned']}", file=sys.stderr)

    owner = None
    if toon_counts:
        most_common, appearances = toon_counts.most_common(1)[0]
        if appearances >= max(3, len(metadata) * 0.5):
            owner = most_common
    groups: dict[tuple[str, str], list] = defaultdict(list)
    for item in metadata:
        for label in item["labels"]:
            if label[0] != owner:
                groups[label].append(item)
    repeated = sorted((key for key, games in groups.items() if len(games) >= 2), key=lambda key: digest("|".join(key)))
    selected = {}
    # Pick two disjoint games per repeated account before adding more samples.
    # Hash ordering is stable and spreads maps/dates independently of filenames.
    for key in repeated:
        pair = sorted(groups[key], key=lambda item: item["hash"])[:2]
        if len(set(selected) | {item["hash"] for item in pair}) > args.limit:
            continue
        selected.update({item["hash"]: item for item in pair})
    for item in sorted(metadata, key=lambda item: item["hash"]):
        if len(selected) >= args.limit:
            break
        selected[item["hash"]] = item

    rows = []
    for index, item in enumerate(selected.values()):
        try:
            replay = sc2reader.load_replay(str(item["path"]), load_level=4)
            if _is_resumed_replay(replay):
                counters["excludedResumedReplays"] += 1
                continue
            length = real_game_length(replay)
            if length < 120:
                counters["excludedShortReplays"] += 1
                continue
            players = list(replay.players)
            first_events, second_events, _ = extract_events(replay, players[0].pid)
            for p_index, player in enumerate(players):
                toon = str(player.toon_handle)
                if toon == owner:
                    continue
                signature = _compute_opponent_play_signature(
                    SimpleNamespace(raw=replay, length_seconds=length),
                    opponent_pid=player.pid,
                    opp_build_log=build_log_lines(first_events if p_index == 0 else second_events, cutoff_seconds=None),
                )
                if signature is None:
                    counters["missingSignatures"] += 1
                    continue
                rows.append({
                    "label": digest(toon), "replayHash": item["hash"],
                    "timestamp": item["timestamp"], "race": player.play_race,
                    "facingRace": players[1 - p_index].play_race,
                    "durationSec": round(length), "signature": signature,
                })
            counters["replaysExtracted"] += 1
        except Exception as exc:
            counters["extractionErrors"] += 1
            print(f"Full parse failed ({type(exc).__name__}): {item['path'].name}", file=sys.stderr)
        print(f"Full event parse: {index + 1}/{len(selected)}", file=sys.stderr)

    output = {"formatVersion": 1, "source": "real_sc2_replays", "selection": "repeated_opponent_accounts_first",
              "dominantAccountExcluded": owner is not None, "counters": dict(counters),
              "selectedReplays": len(selected), "rows": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({**dict(counters), "rows": len(rows), "output": str(args.output.resolve())}))


if __name__ == "__main__":
    main()
