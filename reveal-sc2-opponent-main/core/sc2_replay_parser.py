"""
Unified sc2reader replay parser.

This is the single entry point both the live overlay watcher and the
post-game analyzer use to load a replay. The depth argument controls
the load_level passed to sc2reader:

    depth="live"  -> load_level=2 (fast, ~150 ms; players + map + result)
    depth="deep"  -> load_level=4 (full, ~2-4 s; tracker events + stats)

The parser also normalizes the player-identification flow so the
"is me" check is the same everywhere: substring match against the
configured player handle (case-sensitive) so clan tags and small
display-name variations don't break detection.

Returned ReplayContext is a plain dict-like object. Callers that need
post-game classification additionally call extract_events / detector
classes via the supplied helpers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import sc2reader
from sc2reader.events.tracker import PlayerStatsEvent

from .build_definitions import BUILD_DEFINITIONS
from .custom_builds import load_custom_builds
from .event_extractor import build_log_lines, extract_events
from .strategy_detector import OpponentStrategyDetector, UserBuildDetector


# =========================================================
# Result dataclasses
# =========================================================
@dataclass
class PlayerInfo:
    pid: int
    name: str
    race: str  # 'Zerg' / 'Protoss' / 'Terran'
    result: str  # 'Win' / 'Loss' / 'Tie' / 'Unknown'
    handle: Optional[str] = None  # toon_handle if available
    mmr: Optional[int] = None
    is_human: bool = True
    is_observer: bool = False


@dataclass
class ReplayContext:
    """Result of parse_replay(). Always populated; fields gated by depth."""
    file_path: str
    depth: str  # "live" or "deep"

    map_name: str = ""
    date_iso: str = "unknown"
    length_seconds: int = 0
    is_ai_game: bool = False

    me: Optional[PlayerInfo] = None
    opponent: Optional[PlayerInfo] = None
    all_players: List[PlayerInfo] = field(default_factory=list)

    # Deep-parse only:
    my_events: List[Dict] = field(default_factory=list)
    opp_events: List[Dict] = field(default_factory=list)
    extract_stats: Dict[str, int] = field(default_factory=dict)
    my_build: Optional[str] = None
    opp_strategy: Optional[str] = None
    build_log: List[str] = field(default_factory=list)
    early_build_log: List[str] = field(default_factory=list)  # first 5 min, for !build
    graph_data: Optional[Dict[str, Any]] = None

    # The raw sc2reader.Replay object for callers that need to dig deeper.
    raw: Any = None

    # Computed game id (matches the analyzer's format).
    game_id: str = ""

    # Game-id-style cache key for cross-DB linking. Set when both DBs
    # need to reference the same match.
    pulse_id: Optional[str] = None


# =========================================================
# Identity helpers
# =========================================================
def is_me(player_name: str, my_handle: str) -> bool:
    """
    Substring-match the configured player handle against a replay
    player name. This handles clan tags like "[CLAN]ReSpOnSe" without
    requiring an exact match.
    """
    if not player_name or not my_handle:
        return False
    return my_handle in player_name


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _get_player_mmr(p) -> Optional[int]:
    """
    Return real MMR if sc2reader exposes it on the player, else None.

    SC2 replays do not reliably carry MMR for modern Battle.net. We
    only trust ``scaled_rating`` and ``mmr`` (both real ratings on the
    1000-7000 range when present). ``highest_league`` is a small enum
    (Bronze..Grandmaster, plus a sentinel for Unranked) and was
    previously used as a fallback - that produced bogus values like
    7 in the live payload. When sc2reader has no rating, return None
    and let the SC2Pulse post-match fetch be the source of truth.

    Example:
        >>> class P: scaled_rating = 5187
        >>> _get_player_mmr(P())
        5187
    """
    # MMRs in modern SC2 are 4-digit ratings; reject anything below
    # this floor as a misread enum/league value.
    MIN_PLAUSIBLE_MMR = 500
    for attr in ("scaled_rating", "mmr"):
        val = getattr(p, attr, None)
        if isinstance(val, (int, float)) and val >= MIN_PLAUSIBLE_MMR:
            return int(val)
    return None


def _player_to_info(p) -> PlayerInfo:
    return PlayerInfo(
        pid=getattr(p, "pid", 0) or 0,
        name=getattr(p, "name", "") or "",
        race=getattr(p, "play_race", "") or "",
        result=getattr(p, "result", "Unknown") or "Unknown",
        handle=getattr(p, "toon_handle", None),
        mmr=_get_player_mmr(p),
        is_human=getattr(p, "is_human", True),
        is_observer=getattr(p, "is_observer", False),
    )


# =========================================================
# sc2reader load with graceful fallback
# =========================================================
def _load_replay(file_path: str, load_level: int):
    """
    Load a replay, tolerating the well-known load_level=4 crashes on
    some replays by falling back to level 3, then level 2.
    """
    last_exc = None
    for lvl in (load_level, 3, 2):
        try:
            return sc2reader.load_replay(file_path, load_level=lvl)
        except Exception as exc:
            last_exc = exc
            continue
    raise last_exc if last_exc else RuntimeError("sc2reader load failed")


def _resolve_me_opp(replay, my_handle: str) -> Tuple[Optional[Any], Optional[Any]]:
    """
    Return (me_player, opp_player) by substring-matching my_handle.
    First non-me human player is treated as opponent.
    """
    me, opp = None, None
    for p in replay.players:
        if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
            continue
        if me is None and is_me(getattr(p, "name", ""), my_handle):
            me = p
        else:
            if opp is None:
                opp = p
    return me, opp


# =========================================================
# Graph data (deep-parse only)
# =========================================================
def _extract_graph_data(replay, me, opp) -> Optional[Dict[str, Any]]:
    if not me or not opp:
        return None
    try:
        data: Dict[str, Any] = {
            "me_name": me.name,
            "opp_name": opp.name,
            "p1_series": [],
            "p2_series": [],
        }
        stats_events = sorted(
            [e for e in replay.tracker_events if isinstance(e, PlayerStatsEvent)],
            key=lambda x: x.second,
        )
        p1_data, p2_data = [], []
        for e in stats_events:
            p_id = getattr(e, "pid", getattr(getattr(e, "player", None), "pid", None))
            if p_id is None:
                continue
            row = {
                "time": e.second / 60.0,
                "supply": getattr(e, "food_used", 0),
                "cap": getattr(e, "food_made", 0),
                "min_rate": getattr(e, "minerals_collection_rate", 0),
                "gas_rate": getattr(e, "vespene_collection_rate", 0),
                "army_val": getattr(
                    e,
                    "minerals_used_active_forces",
                    getattr(e, "minerals_used_current_army", 0),
                )
                + getattr(
                    e,
                    "vespene_used_active_forces",
                    getattr(e, "vespene_used_current_army", 0),
                ),
            }
            if p_id == me.pid:
                p1_data.append(row)
            elif p_id == opp.pid:
                p2_data.append(row)
        data["p1_series"] = p1_data
        data["p2_series"] = p2_data
        return data
    except Exception:
        return None


# =========================================================
# Public API
# =========================================================
def parse_replay(file_path: str, my_handle: str, depth: str = "live") -> ReplayContext:
    """
    Parse a replay and return a ReplayContext.

    depth="live" -> only sc2reader load_level=2 metadata (fast).
    depth="deep" -> load_level=4 + tracker-event extraction + strategy
                    detection + 5-min build log + graph data series.
    """
    if depth not in ("live", "deep"):
        raise ValueError(f"Invalid depth: {depth!r}")

    load_level = 2 if depth == "live" else 4
    replay = _load_replay(file_path, load_level)

    ctx = ReplayContext(file_path=os.path.abspath(file_path), depth=depth, raw=replay)
    ctx.map_name = getattr(replay, "map_name", "") or ""
    ctx.date_iso = replay.date.isoformat() if getattr(replay, "date", None) else "unknown"
    gl = getattr(replay, "game_length", None)
    ctx.length_seconds = gl.seconds if gl else 0

    ctx.all_players = [_player_to_info(p) for p in getattr(replay, "players", [])]

    # AI/computer-game detection: any non-human main slot disqualifies the replay.
    ctx.is_ai_game = any(
        not getattr(p, "is_human", True)
        and not getattr(p, "is_observer", False)
        for p in getattr(replay, "players", [])
    )

    me, opp = _resolve_me_opp(replay, my_handle)
    ctx.me = _player_to_info(me) if me else None
    ctx.opponent = _player_to_info(opp) if opp else None

    if ctx.me and ctx.opponent:
        ctx.game_id = (
            f"{ctx.date_iso}|{ctx.opponent.name}|"
            f"{ctx.map_name or 'unknown'}|{ctx.length_seconds}"
        )

    # Live depth stops here.
    if depth == "live":
        return ctx

    # Deep depth: events, strategy detection, build log, graph data.
    if not ctx.me or not ctx.opponent:
        return ctx  # caller already gets enough metadata to skip cleanly

    my_events, opp_events, ext_stats = extract_events(replay, me.pid)
    ctx.my_events = my_events
    ctx.opp_events = opp_events
    ctx.extract_stats = ext_stats

    custom = load_custom_builds()
    opp_detector = OpponentStrategyDetector(custom["Opponent"])
    my_detector = UserBuildDetector(custom["Self"])

    matchup = f"vs {ctx.opponent.race}"
    ctx.opp_strategy = opp_detector.get_strategy_name(ctx.opponent.race, opp_events, matchup)
    ctx.my_build = my_detector.detect_my_build(matchup, my_events, ctx.me.race)

    ctx.build_log = build_log_lines(my_events, cutoff_seconds=None)
    ctx.early_build_log = build_log_lines(my_events, cutoff_seconds=300)

    ctx.graph_data = _extract_graph_data(replay, me, opp)

    return ctx


def describe_strategy(name: Optional[str]) -> str:
    """Look up the human-readable description of a build/strategy name."""
    if not name:
        return ""
    return BUILD_DEFINITIONS.get(name, "")


# =========================================================
# Convenience entry for the live overlay watcher
# =========================================================
def parse_live(file_path: str, my_handle: str) -> ReplayContext:
    return parse_replay(file_path, my_handle, depth="live")


def parse_deep(file_path: str, my_handle: str) -> ReplayContext:
    return parse_replay(file_path, my_handle, depth="deep")
