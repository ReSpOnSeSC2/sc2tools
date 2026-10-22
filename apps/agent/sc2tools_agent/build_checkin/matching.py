"""Pure helpers that read live envelopes and accepted uploads.

Kept apart from the controller so the eligibility rules — which games
may get a card at all — are small, total functions with direct tests.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from .models import iso_to_ms, normalize_player_name

# An end card is only for the game that just finished: the replay must
# have been played within this window of "now" (same window the API uses
# for fresh overlay games).
ACCEPTED_FRESHNESS_MS = 15 * 60 * 1000
# The replay's start relative to the live key's stamp (taken when the
# loading screen first appeared): a little earlier for clock jitter,
# up to ten minutes later for long loads and pauses before the start.
MATCH_WINDOW_BEFORE_MS = 2 * 60 * 1000
MATCH_WINDOW_AFTER_MS = 10 * 60 * 1000

_RESULTS = frozenset({"Victory", "Defeat", "Tie"})


def players_one_v_one(players: Any) -> Optional[bool]:
    """``True`` for exactly two human players, ``False`` for an AI, team
    or FFA roster, ``None`` while the roster says too little (empty or
    still filling in during loading)."""
    if not isinstance(players, list):
        return None
    rows = [row for row in players if isinstance(row, dict)]
    if not rows:
        return None
    if any(row.get("type") == "computer" for row in rows):
        return False
    humans = [row for row in rows if row.get("type") == "user"]
    if len(rows) > 2 or len(humans) > 2:
        return False
    if len(rows) == 2 and len(humans) == 2:
        return True
    return None


def roster_complete(players: Any) -> bool:
    """Every listed player has a name (identity cannot improve further)."""
    if not isinstance(players, list):
        return False
    rows = [row for row in players if isinstance(row, dict)]
    return len(rows) >= 2 and all(
        isinstance(row.get("name"), str) and row["name"].strip() for row in rows
    )


def user_result(
    players: Any,
    *,
    user_name: Optional[str],
    opponent_name: Optional[str],
) -> Optional[str]:
    """The local player's ``Victory`` / ``Defeat`` / ``Tie``.

    Uses the bridge's resolved names; with only the opponent known, the
    other human's row is ours.
    """
    if not isinstance(players, list):
        return None
    humans = [
        row for row in players
        if isinstance(row, dict) and row.get("type") == "user"
    ]
    mine = normalize_player_name(user_name)
    theirs = normalize_player_name(opponent_name)
    for row in humans:
        name = normalize_player_name(row.get("name"))
        if (mine and name == mine) or (not mine and theirs and name != theirs):
            result = row.get("result")
            return result if result in _RESULTS else None
    return None


def accepted_ineligibility(
    game: Any,
    accepted_row: Mapping[str, Any],
    *,
    now_ms: int,
) -> Optional[str]:
    """Why an accepted upload must not get an agent card, or ``None``.

    Re-sync, OneDrive restores and sweep fallbacks also ride the live
    upload lane, so "accepted" alone does not mean "just played".
    """
    if accepted_row.get("created") is not True:
        return "not_created"
    if accepted_row.get("quarantined"):
        return "quarantined"
    if getattr(game, "match_format", None) != "1v1":
        return "not_1v1"
    if getattr(game, "is_resumed_from_replay", False):
        return "resumed"
    date_ms = iso_to_ms(getattr(game, "date_iso", None))
    if date_ms is None or abs(now_ms - date_ms) > ACCEPTED_FRESHNESS_MS:
        return "stale"
    return None


def game_started_ms(game: Any) -> Optional[int]:
    """Replay start: ``startedAt`` or, failing that, end − duration."""
    started = iso_to_ms(getattr(game, "started_at", None))
    if started is not None:
        return started
    ended = iso_to_ms(getattr(game, "date_iso", None))
    duration = getattr(game, "duration_sec", None)
    if ended is None or isinstance(duration, bool) or not isinstance(duration, (int, float)):
        return None
    return ended - int(duration * 1000)


def opponent_name_of(game: Any) -> str:
    """Normalised replay opponent (clan tag already stripped upstream)."""
    opponent = getattr(game, "opponent", None)
    if not isinstance(opponent, dict):
        return ""
    return normalize_player_name(opponent.get("displayName"))


def within_match_window(started_ms: int, key_ms: int) -> bool:
    return (
        key_ms - MATCH_WINDOW_BEFORE_MS
        <= started_ms
        <= key_ms + MATCH_WINDOW_AFTER_MS
    )


def closest_by_key_ms(candidates: Sequence[Any], started_ms: int) -> Any:
    """The tracked game whose key stamp is nearest the replay start."""
    return min(candidates, key=lambda live: abs(started_ms - live.key_ms))


__all__ = [
    "ACCEPTED_FRESHNESS_MS",
    "MATCH_WINDOW_AFTER_MS",
    "MATCH_WINDOW_BEFORE_MS",
    "accepted_ineligibility",
    "closest_by_key_ms",
    "game_started_ms",
    "opponent_name_of",
    "players_one_v_one",
    "roster_complete",
    "user_result",
    "within_match_window",
]
