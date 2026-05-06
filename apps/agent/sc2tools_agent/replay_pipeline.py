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
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)


def _candidate_bases() -> list[Path]:
    """Yield every plausible base dir to probe for the analyzer roots.

    We're defensive here because PyInstaller's one-file mode has bitten
    us in the past: ``_MEIPASS`` is the canonical extract dir, but on
    some installer configurations the DATAS land next to the .exe
    instead, and on others both locations are valid (one-folder mode).
    Source layout adds yet another variant — Cowork plugins, editable
    installs, and repo-root invocations all resolve ``parents[3]``
    differently.

    Probing every reasonable base costs nothing (just a few stat
    calls) and catches every observed deployment without a special-
    case for each.
    """
    seen: set[str] = set()
    out: list[Path] = []

    def _add(p: Optional[Path]) -> None:
        if p is None:
            return
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            _add(Path(meipass))
        exe_dir = Path(sys.executable).resolve().parent
        _add(exe_dir)
        # One-folder PyInstaller layout sometimes nests the runtime in
        # a subdir next to the launcher (sc2tools-agent/ holds the
        # bundle). Probe both.
        _add(exe_dir.parent)
    else:
        here = Path(__file__).resolve()
        # apps/agent/sc2tools_agent/replay_pipeline.py -> parents[3] is
        # the repo root in the canonical layout. Probe a couple more
        # parents for editable / nested installs.
        for n in (3, 2, 4):
            try:
                _add(here.parents[n])
            except IndexError:
                pass
        # And the cwd, for "python -m sc2tools_agent" launched from
        # inside the repo root.
        _add(Path.cwd())
    return out


def _ensure_analyzer_on_path() -> None:
    """Add the analyzer source roots to sys.path so we can ``import core.*``.

    The actual ``core.sc2_replay_parser`` module lives in
    ``reveal-sc2-opponent-main/core/`` — bundled alongside the agent in
    the frozen exe and laid out at the repo root in source mode.

    The legacy ``SC2Replay-Analyzer`` package is added too because some
    auxiliary helpers historically resolved through it. The reveal
    package is inserted LAST so it ends up FIRST on ``sys.path``:
    ``from core.X`` must resolve through it (it owns
    ``sc2_replay_parser``, ``pulse_resolver`` and the build-detector
    modules the agent actually calls).
    """
    bases = _candidate_bases()
    # Order matters: each insert prepends to sys.path[0], so the LAST
    # entry inserted wins lookup priority. Probe SC2Replay-Analyzer
    # first, then reveal-sc2-opponent-main, so reveal's ``core`` is
    # what Python finds when resolving ``import core.sc2_replay_parser``.
    for sub in ("SC2Replay-Analyzer", "reveal-sc2-opponent-main"):
        for base in bases:
            candidate = base / sub
            if candidate.exists() and str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))


_ensure_analyzer_on_path()


class AnalyzerImportError(RuntimeError):
    """Raised when the bundled analyzer package can't be loaded.

    Distinct from a per-replay parse failure — callers (the watcher)
    must not mark replays as permanently skipped on this error, because
    a future restart or rebuild may resolve it and the replays should
    be re-tried.
    """


def probe_analyzer() -> tuple[bool, Optional[str]]:
    """Try to import ``core.sc2_replay_parser`` once at startup.

    Returns ``(True, None)`` on success, ``(False, error_message)`` on
    failure. The runner calls this right after agent boot so a broken
    bundle is visible in the log immediately — without waiting for the
    first replay to arrive (which can be hours later).

    On failure we also dump the candidate bases we probed and the head
    of ``sys.path`` so the user can see exactly where we looked. That
    diagnostic was missing in v0.3.x and made the "No module named
    'core'" loop genuinely opaque.
    """
    _ensure_analyzer_on_path()
    try:
        from core.sc2_replay_parser import parse_deep  # type: ignore # noqa: F401
        log.info(
            "analyzer_ready frozen=%s sys_path_head=%s",
            getattr(sys, "frozen", False),
            [p for p in sys.path[:4] if p],
        )
        return True, None
    except ImportError as exc:
        bases = [str(b) for b in _candidate_bases()]
        # Synthesise a precise hint about which sibling root we did
        # find — that's almost always what the user needs to fix.
        found_reveal = any((Path(b) / "reveal-sc2-opponent-main" / "core" /
                            "sc2_replay_parser.py").exists() for b in bases)
        found_analyzer = any((Path(b) / "SC2Replay-Analyzer" / "core").exists()
                             for b in bases)
        msg = (
            f"analyzer_import_failed exc={exc!r} "
            f"frozen={getattr(sys, 'frozen', False)} "
            f"reveal_core_present={found_reveal} "
            f"analyzer_core_present={found_analyzer} "
            f"bases_probed={bases} "
            f"sys_path_head={sys.path[:6]}"
        )
        log.error(msg)
        return False, msg


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
        # Re-probe sys.path in case the agent was launched before the
        # bundled DATAS finished extracting (rare PyInstaller race) or
        # the user moved the install. A cheap retry beats permanently
        # skipping every replay the watcher sees.
        ok, diag = probe_analyzer()
        if not ok:
            # Raise instead of returning None so the watcher can tell
            # this apart from a per-replay parse failure and avoid
            # marking the file as permanently skipped. probe_analyzer
            # already logged the full diagnostic, so the message we
            # carry on the exception just needs to identify the cause.
            raise AnalyzerImportError(diag or str(exc)) from exc
        from core.sc2_replay_parser import parse_deep  # type: ignore

    handle = player_handle or _read_player_handle(state_dir)
    try:
        ctx = parse_deep(str(file_path), handle or "")
    except Exception as exc:  # noqa: BLE001
        log.warning("parse_deep_failed for %s: %s", file_path.name, exc)
        return None

    if ctx.is_ai_game:
        return None

    # The configured handle didn't substring-match any player name in
    # this replay. Before giving up, derive the player toon from the
    # file path (replays live in
    # ``Accounts/<account>/<toon>/Replays/Multiplayer/X.SC2Replay``)
    # and re-resolve "us" by toon_handle. This is the canonical
    # identity SC2 itself uses to write the replay, so it can never be
    # ambiguous the way a substring match against a clan-tagged display
    # name can be. Without this fallback, an unset/stale battleTag
    # silently turns every upload into a no-op — exactly the failure
    # mode that left ``state.uploaded`` empty in v0.3.4 even though the
    # analyzer import worked.
    if not ctx.me or not ctx.opponent:
        toon = _toon_handle_from_path(file_path)
        if toon and getattr(ctx, "all_players", None):
            me_p, opp_p = _resolve_by_toon(ctx.all_players, toon)
            if me_p and opp_p and me_p.name:
                # Re-parse with the discovered name so the deep-parse
                # extras (build detector, opp_strategy, build_log) are
                # keyed off the right player. parse_deep is the only
                # path that fills those — calling _resolve_me_opp on
                # the existing ctx would skip them.
                try:
                    ctx = parse_deep(str(file_path), me_p.name)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "parse_deep_failed_after_toon_recovery for %s: %s",
                        file_path.name,
                        exc,
                    )
                    return None

    if not ctx.me or not ctx.opponent:
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


_TOON_HANDLE_RE = re.compile(r"^\d+-S2-\d+-\d+$")


def _toon_handle_from_path(path: Path) -> Optional[str]:
    """Extract the SC2 toon handle from a replay's full path.

    SC2 writes replays to
    ``Documents/StarCraft II/Accounts/<accountId>/<toonHandle>/Replays/Multiplayer/``.
    The toon-handle component is structured as ``<region>-S2-<realm>-<bnid>``
    (e.g. ``1-S2-1-267727``). Return that token if present; otherwise
    None. Used as a deterministic fallback for "who is me?" when the
    user-supplied ``my_handle`` substring match fails.
    """
    for part in path.parts:
        if _TOON_HANDLE_RE.match(part):
            return part
    return None


def _resolve_by_toon(
    all_players: list, toon: str,
) -> tuple[Optional[Any], Optional[Any]]:
    """Pick (me, opp) from ``ctx.all_players`` by exact toon match.

    The ``handle`` attribute on a parsed player is the same
    ``<region>-S2-<realm>-<bnid>`` string SC2 stores in the replay
    payload, so an exact compare against the path-derived toon is
    unambiguous — no clan-tag or rename collisions like the substring
    match against display names suffers.
    """
    me = None
    opp = None
    for p in all_players:
        if getattr(p, "is_observer", False) or getattr(p, "is_referee", False):
            continue
        handle = getattr(p, "handle", None)
        if me is None and handle and str(handle) == toon:
            me = p
        elif opp is None:
            opp = p
    return me, opp


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
