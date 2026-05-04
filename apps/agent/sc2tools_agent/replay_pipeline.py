"""Replay → cloud-game-record pipeline.

The actual parsing is delegated to the existing
``SC2Replay-Analyzer/core/event_extractor.py`` (sc2reader-based, with
the chrono fix at c728ab0). The agent imports those modules so we
never duplicate parsing logic. If the sibling package isn't on
``sys.path``, we add it on import.

This module is the boundary between the watcher (raw file paths) and
the uploader (validated cloud JSON). It NEVER mutates the replay file.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)


def _ensure_analyzer_on_path() -> None:
    """Add SC2Replay-Analyzer/ to sys.path so we can import its core."""
    here = Path(__file__).resolve()
    # apps/agent/sc2tools_agent/replay_pipeline.py
    # → repo root is parents[3]
    for candidate in (
        here.parents[3] / "SC2Replay-Analyzer",
        here.parents[3] / "reveal-sc2-opponent-main",
    ):
        if candidate.exists() and str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


_ensure_analyzer_on_path()


@dataclass
class CloudGame:
    """The shape we POST to /v1/games. Built from a parsed replay."""

    game_id: str
    date_iso: str
    result: str  # Victory | Defeat | Tie
    my_race: str
    my_build: Optional[str]
    map_name: str
    duration_sec: int
    macro_score: Optional[float]
    apm: Optional[float]
    spq: Optional[float]
    opponent: Optional[Dict[str, Any]]
    build_log: list
    early_build_log: list
    opp_early_build_log: list
    opp_build_log: list

    def to_payload(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "gameId": self.game_id,
            "date": self.date_iso,
            "result": self.result,
            "myRace": self.my_race,
            "map": self.map_name,
            "durationSec": int(self.duration_sec),
            "buildLog": self.build_log,
            "earlyBuildLog": self.early_build_log,
            "oppEarlyBuildLog": self.opp_early_build_log,
            "oppBuildLog": self.opp_build_log,
        }
        if self.my_build:
            out["myBuild"] = self.my_build
        if self.macro_score is not None:
            out["macroScore"] = round(float(self.macro_score), 2)
        if self.apm is not None:
            out["apm"] = round(float(self.apm), 2)
        if self.spq is not None:
            out["spq"] = round(float(self.spq), 2)
        if self.opponent:
            out["opponent"] = self.opponent
        return out


def parse_replay_for_cloud(
    file_path: Path,
    *,
    player_handle: Optional[str] = None,
) -> Optional[CloudGame]:
    """Parse one .SC2Replay and return a CloudGame, or None if the
    replay is unusable (AI game, unresolved player, parse error)."""
    try:
        # Lazy import: the analyzer package is only imported when we
        # actually need to parse — keeps startup fast and pairing-only
        # flows from pulling in sc2reader.
        from core.sc2_replay_parser import parse_deep  # type: ignore
    except ImportError as exc:
        log.error(
            "Could not import sc2_replay_parser. "
            "Did you 'pip install -r requirements.txt' "
            "AND keep SC2Replay-Analyzer/ next to apps/agent/? %s",
            exc,
        )
        return None

    handle = player_handle or _read_player_handle()
    try:
        ctx = parse_deep(str(file_path), handle)
    except Exception as exc:  # noqa: BLE001
        log.warning("parse_deep_failed for %s: %s", file_path.name, exc)
        return None

    if ctx.is_ai_game or not ctx.me or not ctx.opponent:
        return None

    me = ctx.me
    opp = ctx.opponent
    result = _result_str(me.result)
    if result is None:
        return None

    opponent = {
        "displayName": _sanitize_name(opp.name),
        "race": opp.race or "U",
    }
    if opp.mmr is not None:
        opponent["mmr"] = int(opp.mmr)
    if getattr(opp, "league_id", None) is not None:
        try:
            opponent["leagueId"] = int(opp.league_id)
        except (TypeError, ValueError):
            pass
    if getattr(ctx, "opp_pulse_id", None):
        opponent["pulseId"] = str(ctx.opp_pulse_id)
    elif opp.handle:
        # Fall back to the toon handle when SC2Pulse hasn't been polled
        # yet; the API treats it as a stable per-opponent id.
        opponent["pulseId"] = str(opp.handle)
    if getattr(ctx, "opp_strategy", None):
        opponent["strategy"] = str(ctx.opp_strategy)

    return CloudGame(
        game_id=str(ctx.game_id),
        date_iso=_to_iso(ctx.date_iso),
        result=result,
        my_race=str(me.race),
        my_build=getattr(ctx, "my_build", None),
        map_name=str(ctx.map_name),
        duration_sec=int(ctx.length_seconds or 0),
        macro_score=getattr(ctx, "macro_score", None),
        apm=getattr(me, "apm", None),
        spq=getattr(me, "spq", None),
        opponent=opponent,
        build_log=list(getattr(ctx, "build_log", []) or []),
        early_build_log=list(getattr(ctx, "early_build_log", []) or []),
        opp_early_build_log=list(getattr(ctx, "opp_early_build_log", []) or []),
        opp_build_log=list(getattr(ctx, "opp_build_log", []) or []),
    )


def _read_player_handle() -> Optional[str]:
    """Cooperate with the existing watcher's config.json convention.

    Resolution order:
      1. SC2TOOLS_PLAYER_CONFIG env var pointing at a config.json
         (legacy compat with the desktop overlay watcher).
      2. SC2TOOLS_PLAYER_HANDLE env var.

    Returns None if neither is usable. NOTE: the empty-string check
    matters — Path('') silently becomes Path('.') on Windows (the cwd,
    which exists), and reading a directory as text raises OSError,
    swallowed by the except below, hiding the env-var fallback. So
    treat an empty/missing SC2TOOLS_PLAYER_CONFIG as "no config file"
    explicitly.
    """
    cfg_path_str = os.environ.get("SC2TOOLS_PLAYER_CONFIG", "").strip()
    if cfg_path_str:
        cfg_path = Path(cfg_path_str)
        if cfg_path.is_file():
            try:
                import json

                cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
                handle = cfg.get("last_player") or cfg.get("player_name")
                if handle:
                    return str(handle)
            except (OSError, ValueError):
                # Fall through to the env-var fallback.
                pass
    return os.environ.get("SC2TOOLS_PLAYER_HANDLE") or None


def _result_str(player_result: Optional[str]) -> Optional[str]:
    if player_result == "Win":
        return "Victory"
    if player_result == "Loss":
        return "Defeat"
    if player_result == "Tie":
        return "Tie"
    return None


def _sanitize_name(name: str) -> str:
    """Strip clan tag prefix [TAG]Name → Name."""
    if not name:
        return ""
    if "]" in name:
        return name.split("]", 1)[1].strip()
    return name.strip()


def _to_iso(date: Any) -> str:
    """Return an RFC 3339 / JSON-Schema 'date-time' string in UTC.

    The server's request schema requires a full date-time including a
    timezone designator. sc2reader's replay.date is a naive datetime
    (no tzinfo), and earlier versions of this helper returned its
    ``isoformat()`` directly — which produced strings like
    '2025-11-25T18:27:19' that the server rejected with
    "/date must match format \"date-time\"". Always normalise to UTC
    with a 'Z' suffix.
    """
    dt: Optional[datetime] = None
    if isinstance(date, datetime):
        dt = date
    elif isinstance(date, str) and date:
        s = date if "T" in date else date.replace(" ", "T")
        # Python's fromisoformat doesn't handle trailing 'Z' until 3.11.
        # Normalise it to '+00:00' which fromisoformat accepts everywhere.
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            dt = None
    if dt is None:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    # Output in UTC with explicit 'Z' designator.
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
