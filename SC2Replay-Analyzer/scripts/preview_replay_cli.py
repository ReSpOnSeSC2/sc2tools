"""Public landing-page preview CLI.

Parses a single .SC2Replay file end-to-end and emits one JSON line that
the cloud's `/v1/public/preview-replay` route streams back to the
marketing landing demo. The output is the smallest shape that lets the
demo render an "opponent dossier" — both players' identity + race +
build log + the shared map / duration.

We deliberately do NOT pick a "you" side: the visitor isn't signed in,
we have no `my_handle`, and a marketing demo doesn't need to identify
the uploader. The modal renders a perspective toggle so the visitor
can read whichever side they care about.

Auth: none. The route is rate-limited per IP and capped at a small
body size so the CLI assumes inputs are tiny, one replay at a time.

Output (stdout, NDJSON, single line on success):

    {
      "ok": true,
      "game_id": "...",
      "map": "Equilibrium LE",
      "duration_sec": 642,
      "players": [
        {
          "name": "ReSpOnSe",
          "race": "Protoss",
          "result": "Victory",
          "build_log": ["[0:00] Probe", ...]
        },
        {
          "name": "scvSlayer",
          "race": "Terran",
          "result": "Defeat",
          "build_log": ["[0:00] SCV", ...]
        }
      ]
    }

On failure: a single object with ``ok: false`` and a ``code`` /
``message`` describing the failure. Exit code is 0 in both branches so
the caller can read stdout instead of guessing from exit codes.

Usage:

    python scripts/preview_replay_cli.py --file /tmp/upload.SC2Replay
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import re

# Cap how many build-log lines we emit. The marketing modal only needs
# enough to look meaningful; the live product is unlimited.
_BUILD_LOG_PREVIEW_LIMIT = 60

# Mirror apps/api/src/services/perGameCompute.js BUILD_LOG_NOISE_RE so
# the demo doesn't render Beacons/Sprays/RewardDance lines that the
# real product filters out at parse time.
_NOISE_RE = re.compile(r"^(Beacon|Reward|Spray)", re.IGNORECASE)


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _err(code: str, message: str) -> int:
    _emit({"ok": False, "code": code, "message": message})
    return 0


def _truncated(lines: List[str]) -> List[str]:
    if len(lines) <= _BUILD_LOG_PREVIEW_LIMIT:
        return lines
    return lines[:_BUILD_LOG_PREVIEW_LIMIT]


def _format_build_log(events: List[Dict[str, Any]]) -> List[str]:
    """Mirror replay_loader.process_replay_task: '[m:ss] Name' per event,
    minus the noise lines (Beacon/Spray/RewardDance) the real product
    filters at parse time."""
    lines: List[str] = []
    for e in sorted(events, key=lambda x: x.get("time", 0)):
        name = str(e.get("name") or "")
        if not name or _NOISE_RE.match(name):
            continue
        t = int(e.get("time", 0) or 0)
        m, s = t // 60, t % 60
        lines.append(f"[{m}:{s:02d}] {name}")
    return _truncated(lines)


def _race(player: Any) -> str:
    raw = getattr(player, "play_race", None) or getattr(player, "pick_race", None)
    s = str(raw or "").strip()
    return s or "Unknown"


def _result(player: Any) -> str:
    s = str(getattr(player, "result", "") or "").strip()
    return s or "Unknown"


def _player_name(player: Any) -> str:
    s = str(getattr(player, "name", "") or "").strip()
    return s or "?"


def _player_handle(player: Any) -> Optional[str]:
    return getattr(player, "toon_handle", None) or getattr(player, "handle", None)


def _is_human(player: Any) -> bool:
    if getattr(player, "is_observer", False):
        return False
    if getattr(player, "is_referee", False):
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview a single replay.")
    parser.add_argument("--file", required=True, help="Path to .SC2Replay")
    args = parser.parse_args()

    path = args.file
    if not os.path.isfile(path):
        return _err("file_not_found", f"replay not found: {path}")

    try:
        from core.replay_loader import load_replay_with_fallback
        from core.event_extractor import extract_events
    except ImportError as exc:
        return _err(
            "parser_import_failed",
            f"could not import analyzer modules: {exc}",
        )

    try:
        replay = load_replay_with_fallback(path)
    except Exception as exc:  # noqa: BLE001
        return _err("parse_failed", f"sc2reader load failed: {exc}")

    humans = [p for p in getattr(replay, "players", []) if _is_human(p)]
    if len(humans) < 2:
        return _err(
            "no_two_humans",
            "this demo only handles 1v1 replays with two human players.",
        )
    p1, p2 = humans[0], humans[1]

    try:
        my_events, opp_events, _ = extract_events(replay, p1.pid)
    except Exception as exc:  # noqa: BLE001
        return _err("extract_failed", f"event extractor failed: {exc}")

    map_name = str(getattr(replay, "map_name", "") or "")
    length_sec = 0
    gl = getattr(replay, "game_length", None)
    if gl is not None and getattr(gl, "seconds", None) is not None:
        length_sec = int(gl.seconds)
    date_str = ""
    if getattr(replay, "date", None) is not None:
        try:
            date_str = replay.date.isoformat()
        except Exception:  # noqa: BLE001
            date_str = ""

    game_id = f"{date_str}|{_player_name(p2)}|{map_name}|{length_sec}"

    payload: Dict[str, Any] = {
        "ok": True,
        "game_id": game_id,
        "map": map_name,
        "duration_sec": length_sec,
        "date": date_str,
        "players": [
            {
                "name": _player_name(p1),
                "race": _race(p1),
                "result": _result(p1),
                "handle": _player_handle(p1),
                "build_log": _format_build_log(my_events),
            },
            {
                "name": _player_name(p2),
                "race": _race(p2),
                "result": _result(p2),
                "handle": _player_handle(p2),
                "build_log": _format_build_log(opp_events),
            },
        ],
    }

    _emit(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
