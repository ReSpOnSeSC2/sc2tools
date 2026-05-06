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
import time
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

    Catches ``Exception`` (not just ``ImportError``) on purpose: a
    badly-bundled frozen exe can fail with ``FileNotFoundError``
    inside sc2reader's data-file loader, ``AttributeError`` in a Qt
    plugin probe, etc. Any of those bubbling out of the boot worker
    would kill the whole agent — but we'd rather log a precise
    diagnostic and let the agent run in a degraded "GUI-only, no
    parsing" mode so the user can still see Settings, fix the
    underlying problem, and try again.
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
    except Exception as exc:  # noqa: BLE001
        bases = [str(b) for b in _candidate_bases()]
        # Synthesise a precise hint about which sibling root we did
        # find — that's almost always what the user needs to fix.
        found_reveal = any((Path(b) / "reveal-sc2-opponent-main" / "core" /
                            "sc2_replay_parser.py").exists() for b in bases)
        found_analyzer = any((Path(b) / "SC2Replay-Analyzer" / "core").exists()
                             for b in bases)
        msg = (
            f"analyzer_import_failed exc_type={type(exc).__name__} "
            f"exc={exc!r} "
            f"frozen={getattr(sys, 'frozen', False)} "
            f"reveal_core_present={found_reveal} "
            f"analyzer_core_present={found_analyzer} "
            f"bases_probed={bases} "
            f"sys_path_head={sys.path[:6]}"
        )
        # log.exception captures the full traceback so the user can see
        # WHICH sub-import failed (sc2reader/data, a missing Qt plugin,
        # whatever) — that's exactly the diagnostic that was missing
        # before we surfaced the v0.3.5 sc2reader-data bug at boot.
        log.exception("analyzer_probe_failed %s", msg)
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
    except Exception as exc:  # noqa: BLE001
        # Catch broader than ImportError on purpose. A frozen exe with
        # missing sc2reader data files raises FileNotFoundError; a Qt
        # plugin probe failing inside an analyzer transitive import
        # raises AttributeError. Both used to slip past an
        # ``except ImportError`` clause and bubble up as uncaught
        # exceptions inside the watcher's ThreadPoolExecutor — which
        # silently swallows them. probe_analyzer normalises every
        # failure mode to a single (ok, diag) signal we can act on.
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
                # Promote the discovered name into the local cache so
                # the NEXT replay's first parse already picks up "us"
                # without needing the toon-fallback re-parse. Without
                # this, every replay in a backfill where the cloud
                # handle is wrong/stale costs two full parse_deep
                # calls (~2× slowdown). One promotion fixes the whole
                # backfill from that point on.
                if state_dir is not None:
                    cached = _read_player_handle(state_dir)
                    if cached != me_p.name:
                        try:
                            from .player_handle import write_cache
                            write_cache(state_dir, me_p.name)
                            log.info(
                                "player_handle_cache_repaired old=%r new=%r "
                                "reason=cloud_handle_did_not_match_replay",
                                cached,
                                me_p.name,
                            )
                        except OSError:
                            log.warning(
                                "player_handle_cache_repair_failed",
                            )

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
    pulse_character_id = _resolve_pulse_character_id(opp, file_path=file_path)
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


def _resolve_pulse_character_id(
    opp: Any, *, file_path: Optional[Path] = None,
) -> Optional[str]:
    """Best-effort toon_handle → SC2Pulse character ID lookup.

    Delegates to the resolver in ``reveal-sc2-opponent-main`` (added to
    sys.path by ``_ensure_analyzer_on_path``). Returns ``None`` when the
    sibling repo isn't present, the resolver is offline, the toon is
    malformed, or no candidate matches the bnid. Never raises — a
    failed lookup is identical in outcome to the resolver returning
    ``None`` and must not break the upload path.

    Tiered wall-clock timeout (added v0.3.10):

      * **Live games** (replay mtime within 30 minutes of now) get
        the full pulse_resolver budget — typically 30 s with
        retries — because the user is staring at the dashboard
        right after the match and wants the opponent's pulse
        profile link to populate.
      * **Backfill** (older replays) get a hard 4 s cap. sc2pulse's
        public API rate-limits aggressively (we measured 0.25 s
        for the first ~3 calls then 25-70 s for subsequent ones)
        and a single 70 s sc2pulse hang against 12 worker threads
        cascades through the whole queue. 4 s is generous against
        warm cache hits; misses fall through to ``None`` and the
        replay uploads with toonHandle/pulseId still set, just
        without ``pulseCharacterId``. The dashboard's view-on-
        sc2pulse link is the only feature that needs the field,
        and it's not worth a 90-second-per-replay backfill stall.

    Override either tier with ``SC2TOOLS_PULSE_TIMEOUT_SEC`` (single
    value applied to both live and backfill; useful for tests). Set
    to ``0`` to disable the lookup entirely (offline / CI builds).

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

    timeout_sec = _pulse_timeout_for(file_path)
    if timeout_sec <= 0:
        return None
    if timeout_sec >= 30:
        # Live game (or test override). No need for the parent-side
        # timeout wrapper — let the resolver's own 30 s × 3-retry
        # logic apply. Saves a thread spawn per call.
        try:
            return resolve_pulse_id_by_toon(str(handle), clean) or None
        except Exception as exc:  # noqa: BLE001
            log.info("pulse_character_id_resolve_failed: %s", exc)
            return None

    # Backfill path: hard wall-clock cap so a slow sc2pulse can't
    # serialise the parse queue. We use a bare daemon thread + a
    # ``threading.Event`` — emphatically NOT a
    # ``concurrent.futures.ThreadPoolExecutor`` inside a ``with``
    # block, which was the v0.3.10 mistake. ``with``-block exit
    # calls ``shutdown(wait=True)`` and that waits for the running
    # call to finish even after we got TimeoutError, defeating the
    # whole point of the timeout. A daemon thread gets abandoned
    # cleanly: it keeps running in the background until the resolver
    # responds (warming the resolver's module-level cache so the
    # NEXT replay against this opponent is instant), but it never
    # blocks the calling parse thread or process exit.
    import threading

    result: list = [None]
    error: list = [None]
    done = threading.Event()

    def _runner() -> None:
        try:
            result[0] = resolve_pulse_id_by_toon(str(handle), clean)
        except Exception as exc:  # noqa: BLE001
            error[0] = exc
        finally:
            done.set()

    t = threading.Thread(
        target=_runner, name="pulse-lookup", daemon=True,
    )
    t.start()
    if not done.wait(timeout=timeout_sec):
        # Timeout — abandon the thread. It will complete eventually
        # and update the resolver's in-memory cache; subsequent
        # replays against the same opponent benefit.
        return None
    if error[0] is not None:
        log.info("pulse_character_id_resolve_failed: %s", error[0])
        return None
    return result[0] or None


def _pulse_timeout_for(file_path: Optional[Path]) -> float:
    """Return the wall-clock cap to apply to one sc2pulse call.

    Logic:
      * env override (``SC2TOOLS_PULSE_TIMEOUT_SEC``) wins when set
      * else, if the replay is recent (mtime within 30 min), 30 s
        — full live-game budget
      * else 4 s — backfill cap

    Negative / non-numeric env values fall through to the tiered
    behaviour. ``0`` disables lookups entirely.
    """
    raw = os.environ.get("SC2TOOLS_PULSE_TIMEOUT_SEC", "").strip()
    if raw:
        try:
            n = float(raw)
            if n >= 0:
                return n
        except ValueError:
            pass
    if file_path is not None:
        try:
            age = time.time() - file_path.stat().st_mtime
            if age < 30 * 60:
                return 30.0
        except OSError:
            pass
    return 4.0


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
