"""Naming a saved replay-buffer clip from the game and filing it in a Highlights folder.

The folder sits beside the file OBS wrote, so it follows the streamer's own
recording folder and needs no setting. Only a video file OBS just reported is
ever moved, and never over another file.
"""
from __future__ import annotations

from datetime import datetime
import logging
from pathlib import Path
import re

from .title_channel import RACE_LETTERS

LOG = logging.getLogger(__name__)
HIGHLIGHTS = "Highlights"
VIDEO_SUFFIXES = {".mkv", ".mp4", ".mov", ".flv", ".ts", ".webm"}
MAX_NAME = 120
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]+')


def _clean(text):
    return _UNSAFE.sub(" ", text if isinstance(text, str) else "").strip(" .")


def clip_name(ended_at, facts):
    """"2026-11-28 21-05 PvZ Victory vs Name on Map": the time, then whatever the game told us."""
    facts = facts if isinstance(facts, dict) else {}
    opponent = facts.get("opponent") if isinstance(facts.get("opponent"), dict) else {}
    mine, theirs = RACE_LETTERS.get(facts.get("my_race")), RACE_LETTERS.get(opponent.get("race"))
    parts = [datetime.fromtimestamp(ended_at).strftime("%Y-%m-%d %H-%M")]
    if mine and theirs:
        parts.append(f"{mine}v{theirs}")
    parts.append(_clean(facts.get("result")) or "Game")
    if _clean(opponent.get("displayName")):
        parts.append("vs " + _clean(opponent["displayName"]))
    if _clean(facts.get("map_name")):
        parts.append("on " + _clean(facts["map_name"]))
    return " ".join(" ".join(parts).split())[:MAX_NAME].strip(" .")


def file_clip(source, name):
    """Move `source` into the Highlights folder beside it as `name`; the new path, or None when it could not be filed."""
    try:
        source = Path(source)
        if not source.is_file() or source.suffix.lower() not in VIDEO_SUFFIXES or source.parent.name == HIGHLIGHTS:
            return None
        folder = source.parent / HIGHLIGHTS
        folder.mkdir(exist_ok=True)
        target = folder / f"{name}{source.suffix.lower()}"
        copy = 1
        while target.exists():
            copy += 1
            target = folder / f"{name} ({copy}){source.suffix.lower()}"
        source.rename(target)
        return target
    except OSError as error:
        LOG.warning("clip_filing_failed %s", type(error).__name__)
        return None
