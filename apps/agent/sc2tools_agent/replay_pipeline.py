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
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


# Mirror the API's gameRecord schema caps in
# ``apps/api/src/validation/gameRecord.js``. The server enforces these
# with AJV's ``maxItems`` and rejects the whole game record with
# ``"/oppBuildLog must NOT have more than 5000 items"`` when exceeded.
# Long Zerg replays routinely produce 8k–14k opp_build_log entries
# because every Zergling/Drone/Overlord spawn is a separate event line,
# and the agent's queue used to retry the rejected payload forever (the
# 2 s sleep + re-enqueue in uploader.queue), filling the bounded
# upload queue and silently dropping every subsequent replay. Capping
# here is the minimal fix: chronological truncation preserves the
# early-/mid-game window the rules engine cares about (rules use
# ``time_lt`` cutoffs that almost always sit inside the first ~10 min,
# well within 5000 events even for a 30-minute Zerg macro game).
_BUILD_LOG_CAP = 5000
_EARLY_BUILD_LOG_CAP = 1000


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


def _load_sc2ra_module(dotted_name: str) -> Any:
    """Load a module by dotted name explicitly from ``SC2Replay-Analyzer/``.

    Both ``SC2Replay-Analyzer/`` and ``reveal-sc2-opponent-main/`` ship
    a ``core/event_extractor.py`` and ``analytics/macro_score.py``.
    ``_ensure_analyzer_on_path`` puts reveal first on ``sys.path`` so
    ``core.sc2_replay_parser`` (which only exists in reveal) resolves —
    but that means ``from core.event_extractor import …`` and
    ``from analytics.macro_score import …`` get the OLDER reveal copies.

    The reveal copies pre-date the v0.5 macro-breakdown surface: they
    omit ``unit_timeline`` and ``opp_stats_events`` from the payload,
    have signature ``(replay, my_pid)`` with no ``opp_pid`` parameter
    so the agent's ``extract_macro_events(replay, me.pid, opp_pid)``
    call raises ``TypeError`` on the third positional argument, and
    read the wrong sc2reader attribute (``food_workers``, which
    doesn't exist on PlayerStatsEvent in sc2reader 1.8.x — the right
    name is ``workers_active_count``). A breakdown built against those
    is exactly what the user sees on the SPA: macro card empty
    ("Macro breakdown not available for this game yet").

    Loading SC2Replay-Analyzer's copy via ``importlib.util.spec_from_file_location``
    sidesteps the ``sys.path`` ordering without touching it (so other
    reveal-only modules like ``sc2_replay_parser`` keep resolving).
    Both target modules have no internal cross-package imports — only
    ``sc2reader`` and stdlib — so loading them in isolation is safe.

    Caching: once we load from disk we register the module under a
    private ``_sc2ra_*`` key in ``sys.modules`` and check that key
    FIRST on subsequent calls. This sidesteps the ``sys.modules``
    pollution that ``from core.sc2_replay_parser import parse_deep``
    causes — that import chain executes reveal's
    ``from .event_extractor import …`` and registers reveal's broken
    copy at ``sys.modules['core.event_extractor']`` BEFORE we ever
    get to compute the macro breakdown.

    Test stub support: tests still need a way to inject fake
    extractors without touching the real file. We honor a sys.modules
    entry at ``dotted_name`` when it has no ``__file__`` attribute or
    when its ``__file__`` points inside ``SC2Replay-Analyzer`` — both
    indicate the entry came from a deliberate inject (test stub or a
    prior call to this loader) rather than from Python's import
    machinery resolving reveal's relative import. A real reveal copy
    has ``__file__`` ending in ``reveal-sc2-opponent-main\\core\\…``
    and is rejected so disk-load takes over.
    """
    import importlib.util
    internal_name = f"_sc2ra_{dotted_name.replace('.', '_')}"
    cached = sys.modules.get(dotted_name)
    # Check sys.modules[dotted_name] FIRST, but only honor entries that
    # are "safe" (test stubs without __file__, or SC2Replay-Analyzer's
    # own loaded copy). The real reveal copy is rejected so disk load
    # runs even when reveal's relative import already populated this
    # key. Doing this check before the internal cache lookup means that
    # tests can monkeypatch.setitem(sys.modules, dotted_name, stub) and
    # have it take effect even after a previous call populated the
    # internal cache.
    if cached is not None and _is_safe_cached_module(cached):
        return cached
    cached_internal = sys.modules.get(internal_name)
    if cached_internal is not None:
        return cached_internal
    parts = dotted_name.split(".")
    rel = Path(*parts[:-1]) / f"{parts[-1]}.py"
    for base in _candidate_bases():
        candidate = base / "SC2Replay-Analyzer" / rel
        if not candidate.exists():
            continue
        spec = importlib.util.spec_from_file_location(
            internal_name, str(candidate),
        )
        if spec is None or spec.loader is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        sys.modules[internal_name] = mod
        spec.loader.exec_module(mod)
        return mod
    raise ImportError(
        f"SC2Replay-Analyzer module not found on disk: {dotted_name}",
    )


def _is_safe_cached_module(mod: Any) -> bool:
    """Return True iff ``mod`` is acceptable as a sc2ra module substitute.

    Real reveal-sc2-opponent-main copies have ``__file__`` containing
    that directory name and the wrong signature — those must be
    rejected so disk load takes over. SimpleNamespace / MagicMock /
    SC2Replay-Analyzer's own copy are all fine.

    Compares against the directory name as a substring (case-insensitive
    on Windows-style paths) rather than a strict prefix so editable
    installs and PyInstaller's _MEIPASS extracts both match. The
    matching is done in lowercase to be robust to case-insensitive
    filesystem casing differences (Windows can return paths with
    inconsistent casing depending on how they were resolved).
    """
    file_attr = getattr(mod, "__file__", None)
    if not file_attr:
        # Test stubs (SimpleNamespace, MagicMock, plain classes)
        # don't have a __file__ — those are what we're trying to
        # support for testing.
        return True
    lowered = str(file_attr).lower()
    if "reveal-sc2-opponent-main" in lowered:
        return False
    return True


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
    # The signed-in player's MMR at the time of the game. Optional —
    # sc2reader only fills this for ranked replays; non-ladder games
    # leave ``me.mmr`` as ``None`` and we forward that through. Defaults
    # to ``None`` so the dataclass stays backwards-compatible with test
    # fixtures that pre-date the field.
    my_mmr: Optional[int] = None
    # The signed-in player's raw sc2reader toon_handle (e.g.
    # ``"2-S2-1-267727"``). Surfaced so the cloud's session-widget MMR
    # fallback can resolve the streamer's CURRENT 1v1 ladder rating via
    # SC2Pulse without forcing them to paste their pulseId into Settings
    # → Profile manually. Optional — pre-cutover replays lack the
    # attribute, and the cloud Tier-3 fallback already handles its
    # absence.
    my_toon_handle: Optional[str] = None
    # Optional structured outputs the cloud uses to render the Activity
    # tab's per-game charts and the macro-breakdown drilldown. Computing
    # these requires a deep parse + extra event walks; we attach them
    # whenever they're available so the SPA never falls back to its
    # "macro breakdown not available" empty state for new uploads.
    macro_breakdown: Optional[Dict[str, Any]] = None
    apm_curve: Optional[Dict[str, Any]] = None
    # Per-replay spatial extracts for the Map Intel heatmaps.
    # Mirrors the SPA's `analytics.spatial.SpatialAggregator` cache:
    # each list is normalized {x, y, weight?, time?} and the cloud
    # rasterises them across N games per map.
    spatial: Optional[Dict[str, Any]] = None

    def to_payload(self) -> Dict[str, Any]:
        # ``earlyBuildLog`` / ``oppEarlyBuildLog`` are intentionally
        # NOT shipped: they are exactly ``buildLog`` / ``oppBuildLog``
        # filtered to ``time < 5:00`` and the server derives them on
        # read in the few services that need them (perGameCompute,
        # dnaTimings, ml). Dropping them off the wire saves ~6 kB per
        # game — about 12 % of the per-doc footprint. See the v0.4.3
        # CHANGELOG for the storage rationale.
        out: Dict[str, Any] = {
            "gameId": self.game_id,
            "date": self.date_iso,
            "result": self.result,
            "myRace": self.my_race,
            "map": self.map_name,
            "durationSec": int(self.duration_sec),
            "buildLog": self.build_log,
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
        if self.my_mmr is not None:
            out["myMmr"] = int(self.my_mmr)
        if self.my_toon_handle:
            out["myToonHandle"] = str(self.my_toon_handle)
        if self.opponent:
            out["opponent"] = self.opponent
        if self.macro_breakdown is not None:
            out["macroBreakdown"] = self.macro_breakdown
        if self.apm_curve is not None:
            out["apmCurve"] = self.apm_curve
        if self.spatial is not None:
            out["spatial"] = self.spatial
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

    macro_breakdown, derived_macro_score = _compute_macro_breakdown(ctx)
    apm_curve = _compute_apm_curve(ctx)
    # Backfill per-player APM/SPM averages on the macro_breakdown's
    # player_stats so the SPA's Replay Player Unit Statistics table
    # can render APM/SPM for BOTH sides without merging two payloads
    # at render time. The slim-row apm/spm fields only carry my-side
    # values; opp's averages have to come from apm_curve.
    if macro_breakdown is not None and apm_curve is not None:
        _merge_apm_into_player_stats(macro_breakdown, apm_curve)
    # Per-replay spatial extracts (battle/death/proxy/building points
    # in world coords + map bounds). The cloud rasterises these across
    # N games per map for the Map Intel heatmaps; without the upload
    # the heatmaps stay empty no matter how many replays the user
    # syncs. Best-effort — failures fall back to None and the heatmap
    # tiles surface their "no spatial data" empty state.
    spatial = _compute_spatial_extract(ctx)

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

    macro_score_value = getattr(ctx, "macro_score", None)
    if macro_score_value is None and derived_macro_score is not None:
        macro_score_value = derived_macro_score

    # Derive the build logs from the parsed event streams. The legacy
    # parser only fills ctx.build_log / ctx.early_build_log for the
    # "us" perspective, so before we ship the upload we synthesize the
    # opponent equivalents from ctx.opp_events. Without this the cloud
    # received empty oppBuildLog arrays and the Save-as-new-build flow
    # for the opponent panel had nothing to capture.
    my_build_log = list(getattr(ctx, "build_log", []) or [])
    early_build_log = list(getattr(ctx, "early_build_log", []) or [])
    opp_build_log = list(getattr(ctx, "opp_build_log", []) or [])
    opp_early_build_log = list(getattr(ctx, "opp_early_build_log", []) or [])
    if not opp_build_log or not opp_early_build_log:
        derived_full, derived_early = _build_log_from_events(
            getattr(ctx, "opp_events", None),
        )
        if not opp_build_log and derived_full:
            opp_build_log = derived_full
        if not opp_early_build_log and derived_early:
            opp_early_build_log = derived_early

    # Cap each list at the server's schema maxItems. Lists are produced
    # by ``build_log_lines`` already sorted ascending by event time, so
    # ``[:N]`` keeps the earliest N events — which is exactly the window
    # the build-order timeline and rules engine read. We capture the
    # pre-cap sizes so the post-cap INFO line can flag truncation: silent
    # truncation would be confusing if a user later saw the build-order
    # timeline stop at the cap minute.
    my_build_log_pre = len(my_build_log)
    opp_build_log_pre = len(opp_build_log)
    my_build_log = my_build_log[:_BUILD_LOG_CAP]
    early_build_log = early_build_log[:_EARLY_BUILD_LOG_CAP]
    opp_build_log = opp_build_log[:_BUILD_LOG_CAP]
    opp_early_build_log = opp_early_build_log[:_EARLY_BUILD_LOG_CAP]
    if (
        my_build_log_pre > _BUILD_LOG_CAP
        or opp_build_log_pre > _BUILD_LOG_CAP
    ):
        log.info(
            "build_log_truncated file=%s build_log=%d->%d "
            "opp_build_log=%d->%d cap=%d",
            file_path.name,
            my_build_log_pre, len(my_build_log),
            opp_build_log_pre, len(opp_build_log),
            _BUILD_LOG_CAP,
        )

    # One-line INFO summary of what we're about to ship. Lets the user
    # confirm at a glance whether the rich payload (macroBreakdown +
    # oppBuildLog + apmCurve + spatial) actually got produced for this
    # replay, or whether one of the fail-soft paths swallowed it. The
    # SPA shows "Macro breakdown not available" / "No opponent build
    # extracted yet" empty states whenever a field is missing, so a
    # post-mortem from the agent log to the dashboard becomes a single
    # grep against this line.
    log.info(
        "replay_payload_ready file=%s build_log=%d opp_build_log=%d "
        "macro_breakdown=%s apm_curve=%s spatial=%s",
        file_path.name,
        len(my_build_log),
        len(opp_build_log),
        "yes" if macro_breakdown is not None else "no",
        "yes" if apm_curve is not None else "no",
        "yes" if spatial is not None else "no",
    )

    my_mmr_raw = getattr(me, "mmr", None)
    try:
        my_mmr = int(my_mmr_raw) if my_mmr_raw is not None else None
    except (TypeError, ValueError):
        my_mmr = None

    # Forward the raw toon_handle so the cloud session-widget MMR
    # fallback can resolve the streamer's current 1v1 ladder rating via
    # SC2Pulse even when no game in their history carries `myMmr` and
    # they haven't pasted a numeric pulseId into Settings → Profile.
    my_toon_handle_raw = getattr(me, "handle", None)
    my_toon_handle = (
        str(my_toon_handle_raw).strip()
        if my_toon_handle_raw not in (None, "")
        else None
    )

    return CloudGame(
        game_id=str(ctx.game_id),
        date_iso=_to_iso(ctx.date_iso),
        result=result,
        my_race=str(me.race),
        my_build=getattr(ctx, "my_build", None),
        map_name=str(ctx.map_name),
        duration_sec=int(ctx.length_seconds or 0),
        macro_score=macro_score_value,
        apm=getattr(me, "apm", None),
        spq=getattr(me, "spq", None),
        my_mmr=my_mmr,
        my_toon_handle=my_toon_handle,
        opponent=opponent,
        build_log=my_build_log,
        early_build_log=early_build_log,
        opp_early_build_log=opp_early_build_log,
        opp_build_log=opp_build_log,
        macro_breakdown=macro_breakdown,
        apm_curve=apm_curve,
        spatial=spatial,
    )


def _build_log_from_events(
    events: Any,
) -> tuple[list, list]:
    """Format an event-stream list as build-log strings.

    Returns ``(full, early)`` where ``early`` is capped at the first
    five minutes (matching the SPA's ``early_build_log`` semantics).
    Empty lists on failure — never raises.

    Failure modes are logged at WARNING (not DEBUG): the SPA's dual
    build-order timeline renders an empty "No opponent build extracted
    yet" panel when these lists are empty, so a silent failure here is
    indistinguishable from a parse with no opp_events. WARNING makes
    the cause visible in standard agent logs without forcing the user
    to flip log_level=DEBUG to diagnose.
    """
    if not events:
        return [], []
    try:
        from core.event_extractor import build_log_lines  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log.warning("build_log_lines_unavailable: %s", exc)
        return [], []
    try:
        full = list(build_log_lines(events, cutoff_seconds=None))
    except Exception as exc:  # noqa: BLE001
        log.warning("build_log_lines_full_failed: %s", exc)
        full = []
    try:
        early = list(build_log_lines(events, cutoff_seconds=300))
    except Exception as exc:  # noqa: BLE001
        log.warning("build_log_lines_early_failed: %s", exc)
        early = []
    return full, early


def _compute_spatial_extract(ctx: Any) -> Optional[Dict[str, Any]]:
    """Extract per-replay spatial events for the cloud Map Intel heatmaps.

    Mirrors the field names the cloud's SpatialService reads from each
    game document:

      - ``map_bounds``     {minX, minY, maxX, maxY} world rectangle
      - ``my_proxies``     [{x, y}] forward bases / proxies (us)
      - ``opp_proxies``    [{x, y}] forward bases / proxies (opp)
      - ``buildings``      [{x, y}] every building we placed
      - ``battles``        [{x, y, weight}] engagement centroids
      - ``deaths``         [{x, y, weight}] places where our army died

    The legacy SPA owns the canonical extraction in
    ``analytics/spatial.SpatialAggregator`` which reads through
    ``core.map_playback_data.build_playback_data``. We piggyback on
    the same parser so the lists mean exactly what the offline app
    means by them.

    Returns ``None`` (not an empty dict) when nothing is available so
    the upload path simply omits the field instead of forcing the
    cloud to store noise.
    """
    me = getattr(ctx, "me", None)
    opp = getattr(ctx, "opponent", None)
    if me is None or opp is None:
        return None
    try:
        from core.map_playback_data import (  # type: ignore
            DEFAULT_BOUNDS,
            bounds_for as _bounds_for,
            build_playback_data as _build_playback_data,
            centroid as _centroid,
            detect_battle_markers as _detect_battle_markers,
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("spatial_imports_unavailable: %s", exc)
        return None
    try:
        from detectors.base import BaseStrategyDetector  # type: ignore
    except Exception:
        BaseStrategyDetector = None  # type: ignore
    replay_path = getattr(ctx, "file_path", None) or getattr(ctx, "replay_path", None)
    if not replay_path:
        # parse_deep populates ctx.raw but build_playback_data wants a
        # filesystem path. If neither is available we skip rather than
        # raise — the rest of the upload still goes through.
        return None
    try:
        playback = _build_playback_data(str(replay_path))
    except Exception as exc:  # noqa: BLE001
        log.debug("build_playback_data_failed: %s", exc)
        return None
    if not playback:
        return None

    map_bounds = None
    try:
        b = _bounds_for(playback) or DEFAULT_BOUNDS
        if isinstance(b, dict):
            map_bounds = {
                "minX": float(b.get("x_min", 0.0)),
                "minY": float(b.get("y_min", 0.0)),
                "maxX": float(b.get("x_max", 200.0)),
                "maxY": float(b.get("y_max", 200.0)),
            }
    except Exception as exc:  # noqa: BLE001
        log.debug("bounds_for_failed: %s", exc)

    out: Dict[str, Any] = {}
    if map_bounds:
        out["map_bounds"] = map_bounds

    my_pid = getattr(me, "pid", None)
    opp_pid = getattr(opp, "pid", None)

    my_buildings: list = []
    opp_buildings: list = []
    for entry in playback.get("buildings") or []:
        if not isinstance(entry, dict):
            continue
        x = entry.get("x")
        y = entry.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        owner = entry.get("owner_pid", entry.get("pid"))
        sample = {"x": float(x), "y": float(y)}
        born = entry.get("born_t")
        if isinstance(born, (int, float)):
            sample["time"] = float(born)
        unit_name = entry.get("name") or entry.get("unit_type")
        if unit_name:
            sample["name"] = str(unit_name)
        if owner == my_pid:
            my_buildings.append(sample)
        elif owner == opp_pid:
            opp_buildings.append(sample)

    if my_buildings:
        out["buildings"] = my_buildings

    # Proxy detection: a building is a "proxy" when it sits closer to
    # the opponent's main than to ours. We use the SPA's
    # BaseStrategyDetector._is_proxy threshold (50 world units) so the
    # cloud and offline view classify identically.
    if BaseStrategyDetector is not None and (my_buildings or opp_buildings):
        try:
            my_main = _main_base_loc(my_buildings)
            opp_main = _main_base_loc(opp_buildings)
            if my_main and opp_main:
                opp_proxies = [
                    p
                    for p in opp_buildings
                    if _euclid(p, my_main) < 50.0
                ]
                my_proxies = [
                    p
                    for p in my_buildings
                    if _euclid(p, opp_main) < 50.0
                ]
                if my_proxies:
                    out["my_proxies"] = my_proxies
                if opp_proxies:
                    out["opp_proxies"] = opp_proxies
        except Exception as exc:  # noqa: BLE001
            log.debug("proxy_classification_failed: %s", exc)

    # Battle + death-zone markers — same _detect_battle_markers helper
    # the SPA uses, normalised to {x, y, weight} so the cloud's
    # gridder can drop them straight into the heatmap.
    try:
        markers = _detect_battle_markers(playback) or []
    except Exception as exc:  # noqa: BLE001
        log.debug("detect_battle_markers_failed: %s", exc)
        markers = []
    battles: list = []
    deaths: list = []
    for m in markers:
        if not isinstance(m, dict):
            continue
        x = m.get("cx", m.get("x"))
        y = m.get("cy", m.get("y"))
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        sample = {"x": float(x), "y": float(y)}
        weight = m.get("weight") or m.get("count")
        if isinstance(weight, (int, float)) and weight > 0:
            sample["weight"] = float(weight)
        t = m.get("t") or m.get("time")
        if isinstance(t, (int, float)):
            sample["time"] = float(t)
        battles.append(sample)
        # When the marker is annotated with "my_lost" > "opp_lost" we
        # treat it as a death-zone for the user; otherwise skip.
        my_lost = m.get("my_army_lost") or m.get("my_lost")
        opp_lost = m.get("opp_army_lost") or m.get("opp_lost")
        try:
            if (
                isinstance(my_lost, (int, float))
                and isinstance(opp_lost, (int, float))
                and my_lost > opp_lost
            ):
                death_sample = dict(sample)
                death_sample["weight"] = float(my_lost - opp_lost)
                deaths.append(death_sample)
        except Exception:  # noqa: BLE001
            pass
    if battles:
        out["battles"] = battles
    if deaths:
        out["deaths"] = deaths

    return out or None


def _main_base_loc(buildings: list) -> Optional[Dict[str, float]]:
    """Pick the canonical "main base" point for the given side.

    First Nexus / CommandCenter / Hatchery wins. Falls back to the
    earliest building if no town hall is present (rare — happens on
    parsing failure).
    """
    townhall_names = {
        "Nexus", "CommandCenter", "Hatchery", "OrbitalCommand",
        "PlanetaryFortress", "Lair", "Hive",
    }
    earliest: Optional[Dict[str, Any]] = None
    earliest_t = float("inf")
    for b in buildings:
        if not isinstance(b, dict):
            continue
        name = b.get("name")
        t = b.get("time", float("inf"))
        if name in townhall_names and isinstance(t, (int, float)) and t < earliest_t:
            earliest = b
            earliest_t = float(t)
    if earliest is None:
        for b in buildings:
            t = b.get("time", float("inf")) if isinstance(b, dict) else float("inf")
            if isinstance(t, (int, float)) and t < earliest_t:
                earliest = b
                earliest_t = float(t)
    if earliest is None:
        return None
    return {"x": float(earliest["x"]), "y": float(earliest["y"])}


def _euclid(a: Dict[str, Any], b: Dict[str, Any]) -> float:
    try:
        dx = float(a["x"]) - float(b["x"])
        dy = float(a["y"]) - float(b["y"])
        return (dx * dx + dy * dy) ** 0.5
    except (KeyError, TypeError, ValueError):
        return float("inf")


def _compute_macro_breakdown(
    ctx: Any,
) -> tuple[Optional[Dict[str, Any]], Optional[float]]:
    """Build the macroBreakdown payload the cloud stores alongside the game.

    Returns ``(payload, score)`` where ``payload`` is the dict spread into
    the game document's ``macroBreakdown`` field (matching the shape the
    web app's ``MacroBreakdownData`` type expects) and ``score`` is the
    macro_score the engine derived (used as a fallback when the parser
    didn't surface one). Either may be ``None`` on failure — the upload
    path treats that as "no breakdown available, fall back to the slim
    record" rather than failing the whole game ingest.
    """
    me = getattr(ctx, "me", None)
    opp = getattr(ctx, "opponent", None)
    replay = getattr(ctx, "raw", None)
    if me is None or replay is None:
        return None, None
    try:
        # Pin to SC2Replay-Analyzer's copies — see _load_sc2ra_module
        # for why ``from core.event_extractor import …`` would
        # otherwise serve the older reveal copy that omits
        # unit_timeline / opp_stats_events and reads the wrong
        # workers attribute.
        extract_macro_events = _load_sc2ra_module(
            "core.event_extractor",
        ).extract_macro_events
        compute_macro_score = _load_sc2ra_module(
            "analytics.macro_score",
        ).compute_macro_score
    except Exception as exc:  # noqa: BLE001
        # WARNING (not DEBUG) so a missing-DATAS frozen-exe regression
        # doesn't silently turn every replay's macro card into the
        # "Macro breakdown not available" empty state. See the v0.4.0
        # CHANGELOG entry — fail-soft is the right policy, but the
        # cause has to be visible in standard agent logs.
        log.warning("macro_breakdown_imports_unavailable: %s", exc)
        return None, None
    try:
        # Pass opp_pid so unit_timeline includes both sides — the
        # SPA's composition snapshot reads ``entry.opp`` for the
        # opponent column, and without opp_pid that map stays empty.
        opp_pid = getattr(opp, "pid", None) if opp is not None else None
        my_macro = extract_macro_events(replay, me.pid, opp_pid)
    except Exception as exc:  # noqa: BLE001
        log.warning("extract_macro_events_my_failed: %s", exc)
        return None, None
    opp_stats: list = []
    if opp is not None and getattr(opp, "pid", None) is not None:
        # When extract_macro_events ran with both pids above we
        # already have the opp samples on ``my_macro`` — the new
        # SC2Replay-Analyzer extractor returns them under
        # ``opp_stats_events``. Fall back to a separate call against
        # the old extractor signature for safety.
        opp_stats = list(my_macro.get("opp_stats_events") or [])
        if not opp_stats:
            try:
                opp_macro = extract_macro_events(replay, opp.pid)
                opp_stats = list(opp_macro.get("stats_events") or [])
            except Exception as exc:  # noqa: BLE001
                log.warning("extract_macro_events_opp_failed: %s", exc)
                opp_stats = []
    game_length = (
        int(my_macro.get("game_length_sec") or 0)
        or int(getattr(ctx, "length_seconds", 0) or 0)
    )
    score: Dict[str, Any] = {}
    try:
        # Score on the FULL stats_events stream so leaks/SQ/penalty
        # accuracy is unaffected by the wire-level downsample below.
        score = compute_macro_score(my_macro, me.race, game_length)
    except Exception as exc:  # noqa: BLE001
        # Don't bail here — the chart side of the breakdown only needs
        # stats_events + unit_timeline, which we already extracted
        # successfully. Returning None at this point would empty the
        # entire macro card (chart, roster, leaks list) for any replay
        # where the score engine hits an edge case (new race-specific
        # leak rule, divide-by-zero on a 30 s sub-game, etc.). Log
        # loudly so the cause stays grep-able and ship the partial
        # payload — score and leaks default to "no data" gracefully on
        # the SPA side.
        log.warning("compute_macro_score_failed: %s", exc)
        score = {}
    macro_score_val = score.get("macro_score") if isinstance(score, dict) else None
    # sc2reader's PlayerStatsEvent fires every ~10 s, which is finer
    # resolution than the SPA's resource/army charts can render
    # (typical chart widths give ~5–10 px per sample at 30 s, so the
    # 10 s grid is invisible). Downsampling to 30 s buckets cuts each
    # ``stats_events`` array to roughly a third of its original size
    # — about 12 kB / game saved, the single biggest knob in the
    # per-game payload. The macro_score above already ran against the
    # full stream so nothing scoring-side is affected.
    my_stats_full = list(my_macro.get("stats_events") or [])
    my_stats_ds = _downsample_stats_events(my_stats_full)
    opp_stats_ds = _downsample_stats_events(opp_stats)
    # Match unit_timeline against the downsampled my-stats sample times
    # so the SPA's chart hover and unit-composition snapshot land on
    # the SAME ticks as the army/worker lines. unit_timeline at the
    # full 10 s cadence would unbalance the wire payload; the chart
    # can't render finer than 30 s anyway.
    unit_timeline = _downsample_unit_timeline(
        list(my_macro.get("unit_timeline") or []),
        kept_times=[int(s.get("time", 0)) for s in my_stats_ds],
    )
    score_raw = score.get("raw", {}) if isinstance(score, dict) else {}
    score_all_leaks = score.get("all_leaks", []) if isinstance(score, dict) else []
    score_top_leaks = score.get("top_3_leaks", []) if isinstance(score, dict) else []
    payload: Dict[str, Any] = {
        "raw": score_raw or {},
        "all_leaks": score_all_leaks or [],
        "top_3_leaks": score_top_leaks or [],
        "stats_events": my_stats_ds,
        "opp_stats_events": opp_stats_ds,
        "unit_timeline": unit_timeline,
        "player_stats": _build_player_stats_summary(
            ctx, my_macro, score_raw or {},
        ),
    }
    derived: Optional[float] = None
    if isinstance(macro_score_val, (int, float)):
        derived = float(macro_score_val)
    return payload, derived


# How wide each ``stats_events`` retention bucket is, in game-time
# seconds. 30 s matches the chart resolution the SPA's
# ResourcesOverTimeChart and ActiveArmyChart render at — finer
# granularity is invisible. The constant is module-level so tests can
# import + assert against it.
_STATS_EVENTS_BUCKET_SEC = 30


def _downsample_stats_events(events: list) -> list:
    """Keep one ``stats_events`` entry per 30 s game-time bucket.

    Input is sc2reader's ~10 s-cadence ``PlayerStatsEvent`` rows;
    output is the FIRST event in each 30 s bucket. We keep the first
    rather than averaging because each row is already a snapshot of
    cumulative state (food_used, minerals_current, etc.) — averaging
    would smooth meaningful spikes (a temporary mineral float, a
    burst of unspent gas) that the user cares about. Empty input
    returns an empty list; a None input is also handled.
    """
    if not events:
        return []
    seen_buckets: set[int] = set()
    out: list = []
    for ev in events:
        try:
            t = int(ev.get("time", 0))
        except (TypeError, ValueError):
            continue
        bucket = t // _STATS_EVENTS_BUCKET_SEC
        if bucket in seen_buckets:
            continue
        seen_buckets.add(bucket)
        out.append(ev)
    return out


def _downsample_unit_timeline(
    timeline: list, *, kept_times: List[int],
) -> list:
    """Keep only unit_timeline entries that align with kept_times.

    The extractor builds unit_timeline at PlayerStatsEvent cadence
    (~10 s); when we downsample stats_events to 30 s buckets the chart
    hover would otherwise show unit composition at times that don't
    correspond to any rendered army-line tick. Filtering to the SAME
    sample times keeps the wire payload small AND keeps the hover
    tooltip's time always landing on a rendered chart sample.

    ``kept_times`` is the list of times surviving stats_events
    downsampling. Empty input returns an empty list; entries whose
    ``time`` is not in kept_times are dropped.
    """
    if not timeline or not kept_times:
        return []
    keep = set(int(t) for t in kept_times)
    out: list = []
    for entry in timeline:
        try:
            t = int(entry.get("time", 0))
        except (TypeError, ValueError):
            continue
        if t in keep:
            out.append(entry)
    return out


def _merge_apm_into_player_stats(
    macro_breakdown: Dict[str, Any], apm_curve: Dict[str, Any],
) -> None:
    """Compute average APM/SPM per side from the apm_curve and write
    them onto ``macro_breakdown["player_stats"]``.

    Average is taken over windows that have any activity (apm or spm
    > 0) so a long idle stretch at game end doesn't suppress the
    headline number — same approach the SPA's APM/SPM chart uses for
    its summary tooltip. Mutates ``macro_breakdown`` in place. Safe to
    call when player_stats is missing — short-circuits cleanly.
    """
    stats = macro_breakdown.get("player_stats")
    if not isinstance(stats, dict):
        return
    by_pid: Dict[int, Dict[str, float]] = {}
    for player in apm_curve.get("players") or []:
        pid = player.get("pid")
        samples = player.get("samples") or []
        active = [
            s for s in samples
            if (s.get("apm") or 0) > 0 or (s.get("spm") or 0) > 0
        ]
        if not active:
            continue
        avg_apm = sum(float(s.get("apm") or 0) for s in active) / len(active)
        avg_spm = sum(float(s.get("spm") or 0) for s in active) / len(active)
        by_pid[int(pid)] = {
            "apm": round(avg_apm, 1),
            "spm": round(avg_spm, 2),
        }
    for key in ("me", "opponent"):
        rec = stats.get(key)
        if not isinstance(rec, dict):
            continue
        pid = rec.get("pid")
        if pid is None:
            continue
        merged = by_pid.get(int(pid))
        if not merged:
            continue
        # Only overwrite when the slim-row value is missing — me.apm
        # already holds the engine's authoritative number for me.
        if rec.get("apm") is None:
            rec["apm"] = merged["apm"]
        if rec.get("spm") is None:
            rec["spm"] = merged["spm"]


def _build_player_stats_summary(
    ctx: Any, my_macro: Dict[str, Any], raw: Dict[str, Any],
) -> Dict[str, Any]:
    """Compose the per-player stats summary for the SPA stats table.

    Merges three sources:
      * ``my_macro["player_stats"]`` — cumulative born/died counters
        the event extractor populated during its tracker walk.
      * ``ctx.me`` / ``ctx.opponent`` — name, race, MMR (opp only),
        APM/SPM (me only).
      * ``raw`` — supply_blocked_seconds for me. Opp's supply-block
        seconds are not currently scored (the macro engine only runs
        on my_pid), so opp's value is left as ``None`` and the SPA
        renders an em-dash rather than a misleading zero.

    Returns a dict with two well-known top-level keys, ``me`` and
    ``opponent`` — flat key-value records the SPA can spread directly
    into the table row. Always returns the dict (never None) so the
    schema validator sees a stable shape.
    """
    me = getattr(ctx, "me", None)
    opp = getattr(ctx, "opponent", None)
    me_pid = getattr(me, "pid", None) if me is not None else None
    opp_pid = getattr(opp, "pid", None) if opp is not None else None
    extractor = my_macro.get("player_stats") or {}

    def _counters_for(pid: Optional[int]) -> Dict[str, int]:
        if pid is None:
            return {}
        # extractor keys are stringified pids (JSON-friendly)
        return dict(extractor.get(str(pid)) or {})

    def _player_record(
        player: Any, *, is_me: bool,
    ) -> Optional[Dict[str, Any]]:
        if player is None:
            return None
        pid = getattr(player, "pid", None)
        record: Dict[str, Any] = {
            "pid": pid,
            "name": _sanitize_name(getattr(player, "name", "") or ""),
            "race": getattr(player, "race", None) or None,
            "is_me": bool(is_me),
            "mmr": None,
            "apm": None,
            "spm": None,
            "supply_blocked_seconds": None,
        }
        for src_attr, dst_key in (
            ("mmr", "mmr"),
            ("scaled_rating", "mmr"),
            ("apm", "apm"),
            ("spm", "spm"),
            ("spq", "spq"),
        ):
            val = getattr(player, src_attr, None)
            if val is None:
                continue
            try:
                record[dst_key] = int(val) if dst_key == "mmr" else float(val)
            except (TypeError, ValueError):
                pass
        if is_me:
            sb = raw.get("supply_blocked_seconds")
            if isinstance(sb, (int, float)):
                record["supply_blocked_seconds"] = float(sb)
        record.update(_counters_for(pid))
        return record

    return {
        "me": _player_record(me, is_me=True),
        "opponent": _player_record(opp, is_me=False),
    }


def _compute_apm_curve(ctx: Any) -> Optional[Dict[str, Any]]:
    """Build the apmCurve payload (windowed APM/SPM samples per player).

    Walks ``replay.events`` once, bucketing each side's command/selection
    actions into 30-second windows, then converts those into per-second
    rates. Mirrors the shape PerGameComputeService.apmCurve returns so
    the SPA's ApmSpmChart renders without further translation.
    """
    me = getattr(ctx, "me", None)
    opp = getattr(ctx, "opponent", None)
    replay = getattr(ctx, "raw", None)
    if me is None or replay is None:
        return None
    window_sec = 30
    me_pid = getattr(me, "pid", None)
    opp_pid = getattr(opp, "pid", None) if opp is not None else None
    counts_apm: Dict[int, Dict[int, int]] = {}
    counts_spm: Dict[int, Dict[int, int]] = {}
    try:
        events = getattr(replay, "events", None) or []
    except Exception:  # noqa: BLE001
        events = []
    try:
        from sc2reader.events.game import (  # type: ignore
            CommandEvent,
            SelectionEvent,
        )
    except Exception:  # noqa: BLE001
        CommandEvent = None  # type: ignore
        SelectionEvent = None  # type: ignore
    for ev in events:
        pid = getattr(ev, "pid", None)
        if pid is None:
            player = getattr(ev, "player", None)
            pid = getattr(player, "pid", None) if player else None
        if pid not in (me_pid, opp_pid):
            continue
        sec = getattr(ev, "second", None)
        if sec is None:
            frame = getattr(ev, "frame", None)
            if frame is not None:
                try:
                    sec = int(frame) // 16
                except (TypeError, ValueError):
                    sec = None
        if sec is None:
            continue
        bucket = int(sec) // window_sec
        if CommandEvent is not None and isinstance(ev, CommandEvent):
            counts_apm.setdefault(pid, {}).setdefault(bucket, 0)
            counts_apm[pid][bucket] += 1
            continue
        if SelectionEvent is not None and isinstance(ev, SelectionEvent):
            counts_spm.setdefault(pid, {}).setdefault(bucket, 0)
            counts_spm[pid][bucket] += 1
    game_length = int(getattr(ctx, "length_seconds", 0) or 0)
    if game_length <= 0:
        return None
    bucket_count = max(1, (game_length + window_sec - 1) // window_sec)
    has_data = False

    def _samples_for(pid: Optional[int]) -> list:
        nonlocal has_data
        if pid is None:
            return []
        out: list = []
        apm_buckets = counts_apm.get(pid, {})
        spm_buckets = counts_spm.get(pid, {})
        for b in range(bucket_count):
            t_sec = b * window_sec
            apm_val = apm_buckets.get(b, 0) * (60 / window_sec)
            spm_val = spm_buckets.get(b, 0) * (60 / window_sec)
            if apm_val or spm_val:
                has_data = True
            out.append({
                "t": t_sec,
                "apm": round(float(apm_val), 1),
                "spm": round(float(spm_val), 1),
            })
        return out

    players: list = []
    if me_pid is not None:
        players.append({
            "pid": me_pid,
            "name": getattr(me, "name", "") or "",
            "race": getattr(me, "race", "") or "",
            "is_me": True,
            "samples": _samples_for(me_pid),
        })
    if opp_pid is not None:
        players.append({
            "pid": opp_pid,
            "name": getattr(opp, "name", "") or "",
            "race": getattr(opp, "race", "") or "",
            "is_me": False,
            "samples": _samples_for(opp_pid),
        })
    return {
        "window_sec": window_sec,
        "has_data": has_data,
        "players": players,
    }


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
