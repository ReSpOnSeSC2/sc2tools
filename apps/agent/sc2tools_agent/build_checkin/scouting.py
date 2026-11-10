"""Private, defensive scouting data and the plain-text copy drawn from it.

The cloud brief is already scoped to the paired account and live game. The
desktop still checks the game key before accepting it. Each player's recent
builds are parsed here for both private views: the loading-card strip and the
Companion's floating scouting report. No Qt, HTTP or disk I/O.
"""

from __future__ import annotations

import re
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from ..live.types import normalise_live_race

RECENT_BUILDS_LIMIT = 5
UNCLASSIFIED_BUILD = "Unclassified build"
# The strip's short form cuts a longer build name, so all five games fit the card.
STRIP_BUILD_NAME_LIMIT = 22
_RESULT_LETTERS = {"Win": "W", "Loss": "L", "Tie": "Tie"}


def plain_text(value: Any, limit: int, *, trim: bool = True) -> str:
    """Bound text in UTF-16 units, matching the note API's character limit."""
    if not isinstance(value, str):
        return ""
    encoded = (value.strip() if trim else value).encode("utf-16-le", errors="replace")[:limit * 2]
    return encoded.decode("utf-16-le", errors="ignore")


def _count(value: Any) -> Optional[int]:
    return value if type(value) is int and 0 <= value <= 1_000_000_000 else None


def _record(raw: Any) -> Optional[tuple[int, int]]:
    if not isinstance(raw, dict):
        return None
    wins, losses = _count(raw.get("w")), _count(raw.get("l"))
    return (wins, losses) if wins is not None and losses is not None else None


def _race_name(value: Any) -> str:
    """The full name for "zerg", "Z" or "Zerg"; empty when the race is unknown."""
    return normalise_live_race(value) or ""


def toon_identity(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if len(value) <= 80 and re.fullmatch(r"\d+-S2-\d+-\d+", value) else None


def _timestamp(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError, OSError):
        return None


@dataclass(frozen=True)
class RecentBuild:
    """One earlier game. ``result`` is always the account owner's own result."""
    build: str = ""
    result: str = ""
    map_name: str = ""
    played_at: Optional[float] = None
    game_id: Optional[str] = None
    race: str = ""


@dataclass(frozen=True)
class RecentBuilds:
    """Each player's newest games, newest first, five at most on each side.

    ``mine`` is the owner's games in this matchup. ``theirs`` is the owner's
    games against this player, the only games the app knows the player's
    builds from; it is empty on a first meeting and None while the server
    cannot tell which account the player is.
    """
    mine: tuple[RecentBuild, ...] = ()
    theirs: Optional[tuple[RecentBuild, ...]] = ()
    matchup: str = ""


@dataclass(frozen=True)
class BuildRowModel:
    game_id: Optional[str]
    result: str
    build: str
    details: str
    summary: str


@dataclass(frozen=True)
class BuildColumnModel:
    heading: str
    empty_text: str
    rows: tuple[BuildRowModel, ...]


@dataclass(frozen=True)
class ScoutingBrief:
    game_key: str
    opponent_name: str
    record: Optional[tuple[int, int]] = None
    last_met_at: Optional[float] = None
    last_result: str = ""
    last_map: str = ""
    opening: str = ""
    opening_samples: Optional[int] = None
    opening_n: Optional[int] = None
    best_build: str = ""
    best_record: Optional[tuple[int, int]] = None
    note: str = ""
    pulse_id: Optional[str] = None
    dossier_path: str = "/app/opponents"
    forecast_share: Optional[float] = None
    forecast_confidence: str = ""
    forecast_effective_n: Optional[float] = None
    also_plays_as: tuple[str, ...] = ()
    opponent_revealed_name: Optional[str] = None
    recent_builds: Optional[RecentBuilds] = None


@dataclass(frozen=True)
class ScoutingStripModel:
    record_line: str
    opening_line: str
    note: str
    dossier_path: str
    pulse_id: Optional[str] = None
    their_builds: str = ""
    your_builds: str = ""


def _recent_build(raw: Any) -> Optional[RecentBuild]:
    if not isinstance(raw, dict):
        return None
    result = raw.get("result")
    return RecentBuild(
        build=plain_text(raw.get("build"), 160),
        result=result if isinstance(result, str) and result in _RESULT_LETTERS else "",
        map_name=plain_text(raw.get("map"), 120),
        played_at=_timestamp(raw.get("date")),
        game_id=plain_text(raw.get("gameId"), 200) or None,
        race=_race_name(raw.get("race")),
    )


def _recent_build_rows(raw: Any) -> tuple[RecentBuild, ...]:
    rows = raw[:RECENT_BUILDS_LIMIT] if isinstance(raw, list) else []
    return tuple(row for row in map(_recent_build, rows) if row is not None)


def parse_recent_builds(raw: Any) -> Optional[RecentBuilds]:
    """Both lists, or None when the server sent none.

    None is an older server: callers then draw exactly what they drew before.
    Two empty lists are a real answer, not a missing one. A missing opponent
    list means the player's account is not known yet.
    """
    if not isinstance(raw, dict):
        return None
    matchup = raw.get("matchup")
    theirs = raw.get("theirs")
    return RecentBuilds(
        mine=_recent_build_rows(raw.get("mine")),
        theirs=_recent_build_rows(theirs) if isinstance(theirs, list) else None,
        matchup=matchup if isinstance(matchup, str) and re.fullmatch(r"[PTZR]v[PTZR]", matchup) else "",
    )


def age_text(then: float, now: float) -> str:
    days = max(0, int((now - then) // 86_400))
    return "today" if days == 0 else "yesterday" if days == 1 else f"{days} days ago"


def recent_games_label(count: int) -> str:
    """How many games a list holds; fewer than five is said outright."""
    if count >= RECENT_BUILDS_LIMIT:
        return f"Last {RECENT_BUILDS_LIMIT} games"
    return "1 earlier game" if count == 1 else f"{count} earlier games"


def _row_model(row: RecentBuild, now: float, preposition: str, current_race: str) -> BuildRowModel:
    build = row.build or UNCLASSIFIED_BUILD
    # A player may have met the owner as another race before.
    details = [f"as {row.race}"] if row.race and current_race and row.race != current_race else []
    details.append(row.map_name or "Unknown map")
    if row.played_at is not None:
        details.append(age_text(row.played_at, now))
    played = f"{row.result} {preposition} {build}" if row.result else build
    return BuildRowModel(row.game_id, row.result, build, " · ".join(details),
                         " · ".join((played, *details)))


def recent_build_columns(builds: RecentBuilds, now: float, opponent_race: Any = None) -> dict[str, BuildColumnModel]:
    """The floating report's two columns, keyed like its cards: ``my`` and ``opp``."""
    mine = tuple(_row_model(row, now, "with", "") for row in builds.mine)
    theirs = tuple(_row_model(row, now, "against", _race_name(opponent_race)) for row in builds.theirs or ())
    you = " · ".join(part for part in ("YOU", builds.matchup) if part)
    if builds.theirs is None:
        opponent = BuildColumnModel("OPPONENT · NOT IDENTIFIED YET",
                                    "Their earlier games appear once this player's account is confirmed.", ())
    else:
        # The app knows a player's builds only from the owner's games against them.
        opponent = BuildColumnModel(
            f"OPPONENT · {recent_games_label(len(theirs)).upper()} VS YOU" if theirs else "OPPONENT · FIRST MEETING",
            "" if theirs else "No earlier games against this player in your library.",
            theirs)
    return {
        "my": BuildColumnModel(
            f"{you} · {recent_games_label(len(mine)).upper()}" if mine else f"{you} · NO EARLIER GAMES",
            "" if mine else "You have no earlier games in this matchup." if builds.matchup else "You have no earlier games.",
            mine),
        "opp": opponent,
    }


def _short_build(build: str, redundant: tuple[str, ...]) -> str:
    """Drop a prefix that only repeats this matchup ("Zerg - 12 Pool" -> "12 Pool")
    and cut a long name, so five games fit the card."""
    prefix, separator, name = build.partition(" - ")
    name = name.strip() if separator and name.strip() and prefix.strip().casefold() in redundant else build
    return name if len(name) <= STRIP_BUILD_NAME_LIMIT else name[:STRIP_BUILD_NAME_LIMIT].rstrip() + "…"


def _builds_line(owner: str, preposition: str, rows: tuple[RecentBuild, ...], redundant: tuple[str, ...]) -> str:
    """One strip line, newest first: "Their last 5 games: W vs 12 Pool ..."."""
    if not rows:
        return ""
    names = [_short_build(row.build, redundant) if row.build else UNCLASSIFIED_BUILD for row in rows]
    games = (f"{_RESULT_LETTERS[row.result]} {preposition} {name}" if row.result else name
             for row, name in zip(rows, names))
    return f"{owner} {recent_games_label(len(rows)).lower()}: " + " · ".join(games)


def _strip_build_lines(builds: RecentBuilds) -> tuple[str, str]:
    """The strip's short form of both lists: ``(their line, your line)``."""
    # "PvZ - " or "Protoss - " on the owner's builds and "ZvP - " or "Zerg - "
    # on a Zerg opponent's say nothing new on a card that already names the
    # matchup. A build from another race keeps its prefix.
    own_view, their_view = builds.matchup, builds.matchup[::-1]
    own_prefixes = tuple(name.casefold() for name in (own_view, _race_name(own_view[:1])) if name)
    their_prefixes = tuple(name.casefold() for name in (their_view, _race_name(their_view[:1])) if name)
    return (_builds_line("Their", "vs", builds.theirs or (), their_prefixes),
            _builds_line("Your", "with", builds.mine, own_prefixes))


def parse_scouting_brief(raw: Any, game_key: str) -> Optional[ScoutingBrief]:
    if not isinstance(game_key, str) or not isinstance(raw, dict) or raw.get("gameKey") != game_key:
        return None
    opponent = plain_text(raw.get("oppName"), 120)
    if not opponent or not game_key or len(game_key) > 300:
        return None
    last = raw.get("lastMet") if isinstance(raw.get("lastMet"), dict) else {}
    forecast = raw.get("forecast") if isinstance(raw.get("forecast"), dict) else {}
    answer = raw.get("bestAnswer") if isinstance(raw.get("bestAnswer"), dict) else {}
    samples, n = _count(forecast.get("samples")), _count(forecast.get("n"))
    opening_valid = samples is not None and n is not None and 0 < samples <= n
    share, effective_n = forecast.get("share"), forecast.get("effectiveN")
    confidence = forecast.get("confidence")
    posterior = (forecast.get("method") == "posterior" and confidence in ("Low", "Medium", "High")
                 and type(share) in (int, float) and math.isfinite(share) and 0 <= share <= 1
                 and type(effective_n) in (int, float) and math.isfinite(effective_n) and 0 <= effective_n <= 75)
    if forecast.get("method") == "posterior":
        opening_valid = bool(posterior and samples is not None and n is not None and 0 <= samples <= n <= 50)
    pulse_id = toon_identity(raw.get("pulseId"))
    # Build the one permitted dossier path from the validated identity; never
    # open a server-provided arbitrary URL, scheme, host or query string.
    path = f"/app/opponents/{pulse_id}" if pulse_id else "/app/opponents"
    result = last.get("result")
    result = _RESULT_LETTERS.get(result, "") if isinstance(result, str) else ""
    return ScoutingBrief(
        game_key=game_key, opponent_name=opponent, record=_record(raw.get("h2h")),
        last_met_at=_timestamp(last.get("at")),
        last_result=result,
        last_map=plain_text(last.get("map"), 120),
        opening=plain_text(forecast.get("name"), 160) if opening_valid else "",
        opening_samples=samples if opening_valid else None,
        opening_n=n if opening_valid else None,
        best_build=plain_text(answer.get("build"), 160),
        best_record=_record(answer), note=plain_text(raw.get("note"), 500) if pulse_id else "",
        pulse_id=pulse_id, dossier_path=path,
        forecast_share=float(share) if posterior and opening_valid else None,
        forecast_confidence=confidence if posterior and opening_valid else "",
        forecast_effective_n=float(effective_n) if posterior and opening_valid else None,
        also_plays_as=tuple(dict.fromkeys(plain_text(value, 120) for value in raw.get("alsoPlaysAs", [])[:3] if isinstance(value, str) and value.strip())) if isinstance(raw.get("alsoPlaysAs"), list) else (),
        opponent_revealed_name=plain_text(raw.get("oppRevealedName"), 120) or None,
        recent_builds=parse_recent_builds(raw.get("recentBuilds")),
    )


def scouting_model(brief: ScoutingBrief, now: float) -> ScoutingStripModel:
    record = "No confirmed record yet"
    if brief.record is not None:
        wins, losses = brief.record
        record = "First meeting" if wins + losses == 0 else f"You {wins}–{losses}"
    if brief.last_met_at is not None:
        detail = " on ".join(part for part in (brief.last_result, brief.last_map) if part)
        record += f" · last met {age_text(brief.last_met_at, now)}" + (f" ({detail})" if detail else "")
    opening = "Opening history not available"
    if brief.opening:
        if brief.forecast_confidence and brief.forecast_share is not None and brief.forecast_effective_n is not None:
            opening = f"Forecast: {brief.opening} ({int(brief.forecast_share * 100 + 0.5)}% · {brief.forecast_confidence} confidence · effective n={brief.forecast_effective_n:.1f})"
        else:
            opening = f"Usually: {brief.opening} ({brief.opening_samples} of last {brief.opening_n})"
    if brief.also_plays_as:
        record += " · also: " + ", ".join(brief.also_plays_as)
    if brief.best_build and brief.best_record is not None:
        wins, losses = brief.best_record
        opening += f" · Best: {brief.best_build} {wins}–{losses}"
    their_builds, your_builds = _strip_build_lines(brief.recent_builds or RecentBuilds())
    return ScoutingStripModel(record, opening, brief.note, brief.dossier_path, brief.pulse_id,
                              their_builds=their_builds, your_builds=your_builds)
