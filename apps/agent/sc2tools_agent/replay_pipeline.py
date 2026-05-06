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
    """Add the analyzer source roots to sys.path so we can ``import core.*``.

    The actual ``core.sc2_replay_parser`` module lives in
    ``reveal-sc2-opponent-main/core/`` — bundled alongside the agent in
    the frozen exe and laid out at the repo root in source mode.

    Both bases are probed because legacy installs may still need the
    ``SC2Replay-Analyzer`` companion modules. The reveal package is
    inserted LAST so it ends up FIRST on ``sys.path``: ``from core.X``
    must resolve through it (it's the package that owns the
    ``sc2_replay_parser``, ``pulse_resolver`` and friends the agent
    actually calls).
    """
    if getattr(sys, "frozen", False):
        # PyInstaller one-file mode unpacks our DATAS into _MEIPASS at
        # startup; the analyzer dirs live at the top of that tree.
        meipass = getattr(sys, "_MEIPASS", None)
        base = Path(meipass) if meipass else Path(sys.executable).resolve().parent
    else:
        # Source: this file is at apps/agent/sc2tools_agent/replay_pipeline.py
        # so the repo root is parents[3].
        base = Path(__file__).resolve().parents[3]

    for sub in ("SC2Replay-Analyzer", "reveal-sc2-opponent-main"):
        candidate = base / sub
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
    state_dir: Optional[Path] = None,
) -> Optional[CloudGame]:
    """Parse one .SC2Replay and return a CloudGame, or None if the
    replay is unusable (AI game, unresolved player, parse error).

    ``player_handle`` is an optional explicit override (e.g. tests).
    Otherwise we resolve through ``state_dir``'s cached cloud value
    or the legacy env-var fallback.
    """
    try:
        # Lazy import: the analyzer package is only imported when we
        # actually need to parse — keeps startup fast and pairing-only
        # flows from pulling in sc2reader.
        from core.sc2_replay_parser import parse_deep  # type: ignore
    except ImportError as exc:
        log.error(
            "Could not import core.sc2_replay_parser. Frozen exe missing "
            "the bundled analyzer (rebuild from packaging/sc2tools_agent.spec) "
            "or, in source mode, ensure reveal-sc2-opponent-main/ sits next "
            "to apps/agent/. sys.path[:6]=%s exc=%s",
            sys.path[:6],
            exc,
        )
        return None

    handle = player_handle or _read_player_handle(state_dir)
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
    # Identity: keep the in-replay toon_handle as the storage key
    # (`pulseId`) so the existing per-opponent record stays stable even
    # when SC2Pulse is offline or the lookup misses. Always emit the
    # raw toon under `toonHandle`. Best-effort resolve to the canonical
    # SC2Pulse character id and emit it as `pulseCharacterId` — that's
    # the value the UI links to on sc2pulse.nephest.com.
    if opp.handle:
        opponent["toonHandle"] = str(opp.handle)
        opponent["pulseId"] = str(opp.handle)
    pulse_character_id = _resolve_pulse_character_id(opp)
    if pulse_character_id is not None:
        opponent["pulseCharacterId"] = pulse_character_id
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


def _resolve_pulse_character_id(opp: Any) -> Optional[str]:
    """Best-effort toon_handle → SC2Pulse character ID lookup.

    Delegates to the resolver in ``reveal-sc2-opponent-main`` (added to
    sys.path by ``_ensure_analyzer_on_path``). Returns ``None`` when the
    sibling repo isn't present, the resolver is offline, the toon is
    malformed, or no candidate matches the bnid. Never raises — a
    failed lookup is identical in outcome to the resolver returning
    ``None`` and must not break the upload path.

    The same toon is cached process-wide inside the resolver, so a
    catch-up scan of N replays against the same opponent only hits
    SC2Pulse once.
    """
    handle = getattr(opp, "handle", None)
    if not handle:
        return None
    try:
        from core.pulse_resolver import resolve_pulse_id_by_toon  # type: ignore
    except ImportError:
        return None
    name = getattr(opp, "name", "") or ""
    clean = name.split("]", 1)[1].strip() if "]" in name else name.strip()
    try:
        return resolve_pulse_id_by_toon(str(handle), clean) or None
    except Exception as exc:  # noqa: BLE001
        log.info("pulse_character_id_resolve_failed: %s", exc)
        return None


def _read_player_handle(state_dir: Optional[Path] = None) -> Optional[str]:
    """Resolve the player handle without touching the network.

    Order: cloud disk cache (refreshed at agent start-up) > legacy
    SC2TOOLS_PLAYER_CONFIG JSON > SC2TOOLS_PLAYER_HANDLE env var.

    See ``player_handle.refresh_from_cloud`` for the cache-write side.
    """
    from .player_handle import resolve

    return resolve(state_dir)


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
