"""Channel tags for a game, derived from the synced session. No network, no Qt.

Both providers accept letters and digits only, 25 characters at most, ten tags
at most, so one rule keeps every tag valid on either platform. A tag that does
not pass is dropped, never trimmed into something else.
"""
from __future__ import annotations

import re

MAX_TAGS = 10
MAX_TAG_LENGTH = 25
TAG_PATTERN = re.compile(rf"[A-Za-z0-9]{{1,{MAX_TAG_LENGTH}}}\Z")
RACE_LETTERS = {"Protoss": "P", "Terran": "T", "Zerg": "Z"}
LEAGUES = {"Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"}
CHANNEL_PLATFORMS = ("twitch", "kick")


def valid_tag(tag):
    return isinstance(tag, str) and TAG_PATTERN.match(tag) is not None


def channel_tags(stats):
    """Tags in priority order: game mode, matchup, race, league.

    A custom game gets ViewerGames and a running Series gets Tournament. Race
    and matchup come from the match being played; the league from the session.
    """
    stats = stats if isinstance(stats, dict) else {}
    match = stats.get("currentMatch") if isinstance(stats.get("currentMatch"), dict) else {}
    context = stats.get("tagContext") if isinstance(stats.get("tagContext"), dict) else {}
    mine, theirs = match.get("race"), match.get("opponentRace")
    candidates = [
        "ViewerGames" if context.get("custom") is True else None,
        "Tournament" if context.get("series") is True else None,
        f"{RACE_LETTERS[mine]}v{RACE_LETTERS[theirs]}" if mine in RACE_LETTERS and theirs in RACE_LETTERS else None,
        mine if mine in RACE_LETTERS else None,
        stats.get("league") if stats.get("league") in LEAGUES else None,
    ]
    tags = []
    for tag in candidates:
        if valid_tag(tag) and tag not in tags:
            tags.append(tag)
    return tags[:MAX_TAGS]
