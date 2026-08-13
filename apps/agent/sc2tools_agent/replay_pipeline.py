"""Replay → cloud-game-record pipeline.

The actual parsing is delegated to the existing
``apps/replay-engine/core/event_extractor.py`` (sc2reader-based, with
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
from collections.abc import Mapping
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
    """Add the replay engine source root to sys.path so we can ``import core.*``.

    The replay engine (``apps/replay-engine``) owns the entire parse
    surface the agent calls — ``core.sc2_replay_parser`` (parse_deep /
    parse_live), ``core.pulse_resolver``, ``core.event_extractor``,
    ``core.map_playback_data``, ``core.timebase``, the build-definition
    and strategy-detector modules, and ``analytics.macro_score``. It is
    bundled alongside the agent in the frozen exe and laid out under
    ``apps/replay-engine`` at the repo root in source mode.
    """
    bases = _candidate_bases()
    for sub in ("apps/replay-engine",):
        for base in bases:
            candidate = base / sub
            if candidate.exists() and str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))


_ensure_analyzer_on_path()


def bootstrap_analyzer_path() -> None:
    """Public, idempotent entry point for re-bootstrapping the analyzer roots.

    Identical behaviour to ``_ensure_analyzer_on_path`` — exposed under a
    public name so the watcher's ``ProcessPoolExecutor`` workers can call
    it as the FIRST thing they do on the child side.

    Why this matters in process-pool mode (added v0.5.8):

    On Windows, ``multiprocessing`` uses the ``spawn`` start method, which
    re-runs ``__main__.py`` from scratch in the child. The child's
    ``sys.path`` is NOT a copy of the parent's — it's whatever the
    interpreter assembles at startup, plus whatever each imported module
    appends. The parent's manual ``sys.path`` mutations (the
    ``_ensure_analyzer_on_path`` call below) live ONLY in the parent.

    Importing ``sc2tools_agent.replay_pipeline`` in the child re-runs the
    module-scope call to ``_ensure_analyzer_on_path`` and that DOES
    bootstrap the path inside the child. But that only works if the
    child happens to import this module before doing anything that needs
    the analyzer — and on PyInstaller's frozen exe, the import order is
    not always what you'd expect (sc2reader's data-file lookups, for
    instance, may run before the agent module load completes).

    Calling ``bootstrap_analyzer_path()`` explicitly at the very top of
    the worker function removes that ordering dependency. It's
    idempotent (every call is a no-op if the paths are already on
    ``sys.path``) and side-effect-only (mutates ``sys.path`` in place,
    returns nothing), so callers can invoke it freely without worrying
    about repeated work.
    """
    _ensure_analyzer_on_path()


def _load_sc2ra_package_module(submodule: str) -> Any:
    """Load ``core.<submodule>`` from apps/replay-engine AS A PACKAGE.

    ``_load_sc2ra_module`` loads single files in isolation, which
    breaks modules that use package-relative imports
    (``from .paths import APP_DIR``). This loader registers a private
    ``_sc2ra_pkg_core`` package whose ``__path__`` points at
    apps/replay-engine/core, then imports the submodule under it — so
    its relative imports resolve to the ENGINE's sibling files, never
    reveal's stale copies, without touching ``sys.path`` order.

    Test stub support mirrors ``_load_sc2ra_module``: a pre-seeded
    ``sys.modules['_sc2ra_pkg_core.<submodule>']`` entry wins.
    """
    import importlib
    import importlib.util

    pkg_name = "_sc2ra_pkg_core"
    mod_name = f"{pkg_name}.{submodule}"
    cached = sys.modules.get(mod_name)
    if cached is not None:
        return cached
    for base in _candidate_bases():
        core_dir = base / "apps" / "replay-engine" / "core"
        init_py = core_dir / "__init__.py"
        target = core_dir / f"{submodule}.py"
        if not init_py.exists() or not target.exists():
            continue
        if pkg_name not in sys.modules:
            pkg_spec = importlib.util.spec_from_file_location(
                pkg_name,
                str(init_py),
                submodule_search_locations=[str(core_dir)],
            )
            if pkg_spec is None or pkg_spec.loader is None:
                continue
            pkg = importlib.util.module_from_spec(pkg_spec)
            sys.modules[pkg_name] = pkg
            pkg_spec.loader.exec_module(pkg)
        mod = importlib.import_module(mod_name)
        return mod
    raise ImportError(
        f"replay-engine package module not found on disk: core.{submodule}",
    )


def _load_sc2ra_module(dotted_name: str) -> Any:
    """Load a module by dotted name explicitly from ``apps/replay-engine/``.

    Both ``apps/replay-engine/`` and ``reveal-sc2-opponent-main/`` ship
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

    Loading apps/replay-engine's copy via ``importlib.util.spec_from_file_location``
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
    when its ``__file__`` points inside ``apps/replay-engine`` — both
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
    # are "safe" (test stubs without __file__, or apps/replay-engine's
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
        candidate = base / "apps" / "replay-engine" / rel
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
        f"replay-engine module not found on disk: {dotted_name}",
    )


def _is_safe_cached_module(mod: Any) -> bool:
    """Return True iff ``mod`` is acceptable as a sc2ra module substitute.

    Real reveal-sc2-opponent-main copies have ``__file__`` containing
    that directory name and the wrong signature — those must be
    rejected so disk load takes over. SimpleNamespace / MagicMock /
    the replay engine's own copy are all fine.

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
        # Synthesise a precise hint about whether the engine root we
        # need was actually found — that's almost always what the user
        # needs to fix.
        found_engine = any(
            (Path(b) / "apps" / "replay-engine" / "core" /
             "sc2_replay_parser.py").exists()
            for b in bases
        )
        msg = (
            f"analyzer_import_failed exc_type={type(exc).__name__} "
            f"exc={exc!r} "
            f"frozen={getattr(sys, 'frozen', False)} "
            f"engine_core_present={found_engine} "
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
    # Total players in the replay. Retained as display metadata and as a
    # safe legacy 1v1 fallback; counts above two can also describe FFA, so
    # authoritative team filtering uses ``match_format`` below. Optional
    # for backwards compatibility with older fixtures.
    player_count: Optional[int] = None
    # Authoritative ladder-vs-custom signal from the replay's matchmaking
    # category (sc2reader ``replay.category``/``amm``). True = ranked
    # ladder game, False = custom/unranked. The cloud prefers this over
    # the map-name proxy for the FilterBar's ladder / Custom filter, so a
    # custom game on a ladder map (or a ladder game on a since-retired
    # map) classifies correctly. ``None`` when the replay doesn't expose
    # enough evidence; strict cloud filters keep that unknown row out of
    # both explicit buckets rather than guessing from the map name.
    is_ladder_game: Optional[bool] = None
    # Exact SC2 client provenance read from the replay header by the
    # shared replay engine. ``game_version`` is the full sc2reader
    # release string (for example ``5.0.16.97425``); ``game_build`` is
    # the numeric client build. Optional for legacy/corrupt replays.
    game_version: Optional[str] = None
    game_build: Optional[int] = None
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
    # Race selected in the ladder queue. This differs from ``my_race``
    # when the player queues Random: ``my_race`` remains the concrete
    # spawned race used for replay analysis, while this remains Random
    # for ladder-MMR series bucketing. Kept last for positional-call
    # compatibility with older CloudGame constructors.
    my_ladder_race: Optional[str] = None
    # Compact vespene-style playback payload for the cloud's map
    # replayer (unit tracks + buildings + battles over the map). Added
    # AFTER my_ladder_race to preserve positional-call compatibility.
    map_playback: Optional[Dict[str, Any]] = None
    # Exact replay start in RFC 3339 UTC. ``date_iso`` remains the replay
    # end time for backwards compatibility. Added last so positional
    # CloudGame constructors from older integrations keep their meaning.
    started_at: Optional[str] = None
    # Normalized observed replay format. Kept distinct from sc2reader's
    # lobby-selected ``game_type``: ``real_type`` reflects the teams that
    # actually loaded, and can distinguish an FFA from a team game even
    # though both have more than two players. Added last for positional
    # CloudGame constructor compatibility.
    match_format: Optional[str] = None
    # Take Command / Resume from Replay artifacts carry synthetic branch
    # result metadata. They still need to reach the cloud so a full
    # Re-sync can mark rows that an older agent uploaded as ordinary games,
    # but competitive consumers must exclude them. Kept last for positional
    # constructor compatibility.
    is_resumed_from_replay: bool = False
    # Older agent versions may have derived a different gameId for this same
    # local file. The upload queue augments this list from its persistent
    # path_by_game_id reverse index during a full Re-sync.
    resumed_replay_game_ids: Optional[List[str]] = None

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
        if self.my_ladder_race:
            out["myLadderRace"] = str(self.my_ladder_race)
        if self.macro_score is not None:
            out["macroScore"] = round(float(self.macro_score), 2)
        if self.apm is not None:
            out["apm"] = round(float(self.apm), 2)
        if self.spq is not None:
            out["spq"] = round(float(self.spq), 2)
        if self.my_mmr is not None and not self.is_resumed_from_replay:
            out["myMmr"] = int(self.my_mmr)
            out["myMmrSource"] = "replay"
        elif not self.is_resumed_from_replay:
            # Explicit absence lets a resync repair legacy cloud rows
            # that were incorrectly filled with SC2Pulse's current MMR.
            out["myMmrSource"] = "unavailable"
        if self.my_toon_handle:
            out["myToonHandle"] = str(self.my_toon_handle)
        if self.player_count is not None:
            out["playerCount"] = int(self.player_count)
        if self.match_format:
            out["matchFormat"] = str(self.match_format)
        if self.is_ladder_game is not None:
            out["isLadderGame"] = bool(self.is_ladder_game)
        if self.game_version:
            out["gameVersion"] = str(self.game_version)
        if self.game_build is not None:
            out["gameBuild"] = int(self.game_build)
        if self.opponent:
            out["opponent"] = self.opponent
        if self.macro_breakdown is not None:
            out["macroBreakdown"] = self.macro_breakdown
        if self.apm_curve is not None:
            out["apmCurve"] = self.apm_curve
        if self.spatial is not None:
            out["spatial"] = self.spatial
        if self.map_playback is not None:
            out["mapPlayback"] = self.map_playback
        if self.started_at:
            out["startedAt"] = self.started_at
        if self.is_resumed_from_replay:
            out["isResumedFromReplay"] = True
            aliases = _sanitize_resumed_replay_game_ids(
                self.resumed_replay_game_ids,
                current_game_id=self.game_id,
            )
            if aliases:
                out["resumedReplayGameIds"] = aliases
        return out


def _sanitize_resumed_replay_game_ids(
    values: Any,
    *,
    current_game_id: str,
) -> List[str]:
    """Normalize bounded legacy aliases for a resumed-replay marker."""
    if not isinstance(values, (list, tuple, set)):
        return []
    current = str(current_game_id or "").strip()
    seen = {current} if current else set()
    aliases: List[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        game_id = value.strip()
        if not game_id or len(game_id) > 200 or game_id in seen:
            continue
        seen.add(game_id)
        aliases.append(game_id)
        if len(aliases) >= 50:
            break
    return aliases


def _player_count(ctx: Any) -> Optional[int]:
    """Total non-observer players in the replay.

    ``ctx.all_players`` is sc2reader's ``replay.players`` (humans + AI,
    excluding observers) mapped to PlayerInfo. AI games are dropped
    upstream, so on a real upload this is the human headcount: 2 for a
    1v1, or a larger number for teams/FFA. Returns ``None`` when the list
    is empty/absent so the cloud records "unknown" rather than a bogus 0.
    """
    players = getattr(ctx, "all_players", None) or []
    n = len(players)
    return n if n > 0 else None


def _format_from_replay_type(value: Any) -> Optional[str]:
    """Normalize a sc2reader ``real_type`` / ``game_type`` value.

    ``real_type`` normally looks like ``1v1``, ``2v2``, ``2v4``, or
    ``FFA``. Multi-sided all-solo forms (for example ``1v1v1``) are FFA;
    any numeric matchup with a side larger than one is a team game.
    A non-empty value outside those known shapes is preserved as the
    bounded ``other`` bucket instead of being guessed from player count.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    compact = re.sub(r"\s+", "", value).lower()
    if compact == "1v1":
        return "1v1"
    if compact in {"ffa", "freeforall"}:
        return "ffa"
    if re.fullmatch(r"\d+(?:v\d+)+", compact):
        sides = [int(piece) for piece in compact.split("v")]
        if len(sides) > 2 and all(size == 1 for size in sides):
            return "ffa"
        if any(size > 1 for size in sides):
            return "team"
        return "other"
    return "other"


def _match_format(ctx: Any) -> Optional[str]:
    """Return ``1v1`` / ``team`` / ``ffa`` / ``other`` when known.

    Prefer sc2reader's observed ``real_type`` over the lobby-selected
    ``game_type``. Only a two-player count is a safe metadata fallback:
    more than two participants might be FFA, so count alone must never
    label such a replay as a team game.
    """
    raw = getattr(ctx, "raw", None)
    if raw is not None:
        for attr in ("real_type", "game_type"):
            normalized = _format_from_replay_type(getattr(raw, attr, None))
            if normalized is not None:
                return normalized
    return "1v1" if _player_count(ctx) == 2 else None


def _coerce_replay_flag(value: Any) -> Optional[bool]:
    """Coerce sc2reader's bool-like replay flags without guessing."""
    if isinstance(value, bool):
        return value
    # BitPackedDecoder exposes these flags as integer 0/1 in real
    # replays, despite sc2reader documenting them as booleans.
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    return None


def _is_ladder_game(ctx: Any) -> Optional[bool]:
    """Authoritative ranked-ladder vs custom/unranked replay signal.

    Prefer the explicit ranked/competitive flags when a replay version
    exposes either one. The category and AMM flag describe matchmaking
    more broadly and remain compatibility fallbacks. Every flag is
    tri-state: real sc2reader values are numeric 0/1, while missing or
    unfamiliar values stay ``None`` rather than becoming custom.
    """
    raw = getattr(ctx, "raw", None)
    if raw is None:
        return None
    for attr in ("ranked", "competitive"):
        flag = _coerce_replay_flag(getattr(raw, attr, None))
        if flag is not None:
            return flag
    category = getattr(raw, "category", None)
    if isinstance(category, str) and category.strip():
        normalized = category.strip().lower()
        if normalized == "ladder":
            return True
        if normalized in {"private", "public", "single player", "singleplayer"}:
            return False
    flag = _coerce_replay_flag(getattr(raw, "amm", None))
    if flag is not None:
        return flag
    return None


# Skip-reason codes for replays that parse to None. Shared contract
# with the cloud import-progress UI (apps/web ImportProgressCard maps
# each code to human copy), so changes here are wire-format changes.
SKIP_AI_GAME = "ai_game"
# Retained for state/import-progress compatibility with agents <= 0.15.16.
# New resumed artifacts upload a quarantine marker instead of taking this
# local-only skip path.
SKIP_RESUMED_REPLAY = "resumed_replay"
SKIP_PLAYER_UNRESOLVED = "player_unresolved"
SKIP_NO_RESULT = "no_result"
SKIP_PARSE_FAILED = "parse_failed"


def _build_resumed_cloud_game(ctx: Any, me: Any, opp: Any) -> CloudGame:
    """Build the shallow reconciliation marker for a replay-resume session.

    The replay branch's apparent result is retained only so an opt-in history
    view has useful context. ``is_resumed_from_replay`` is authoritative: the
    API excludes the row from competitive statistics and can use this upsert
    to quarantine a false result written by an older desktop agent.
    """
    branch_result = _result_str(getattr(me, "result", None)) or "Tie"
    opponent: Dict[str, Any] = {
        "displayName": _sanitize_name(str(getattr(opp, "name", "") or "")),
        "race": str(getattr(opp, "race", None) or "U"),
    }
    opp_handle = getattr(opp, "handle", None)
    if opp_handle:
        # Keep the stable replay identity, but deliberately do not make the
        # network SC2Pulse lookup used by real games.
        opponent["toonHandle"] = str(opp_handle)
        opponent["pulseId"] = str(opp_handle)
        opponent["pulseLookupAttempted"] = False

    raw_game_id = str(getattr(ctx, "game_id", "") or "")
    if not raw_game_id:
        raw_game_id = (
            f"{getattr(ctx, 'date_iso', 'unknown')}|"
            f"{getattr(opp, 'name', '')}|"
            f"{getattr(ctx, 'map_name', None) or 'unknown'}|"
            f"{int(getattr(ctx, 'length_seconds', 0) or 0)}"
        )

    my_race = str(getattr(me, "race", None) or "Unknown")
    my_ladder_race_raw = getattr(me, "selected_race", None) or my_race
    my_handle = getattr(me, "handle", None)
    started_at_raw = getattr(ctx, "started_at_iso", None)
    return CloudGame(
        game_id=raw_game_id,
        date_iso=_to_iso(getattr(ctx, "date_iso", None)),
        result=branch_result,
        my_race=my_race,
        my_ladder_race=str(my_ladder_race_raw) if my_ladder_race_raw else None,
        my_build=None,
        map_name=str(getattr(ctx, "map_name", None) or "unknown"),
        duration_sec=int(getattr(ctx, "length_seconds", 0) or 0),
        macro_score=None,
        apm=None,
        spq=None,
        my_mmr=None,
        my_toon_handle=str(my_handle) if my_handle else None,
        player_count=_player_count(ctx),
        match_format=_match_format(ctx),
        is_ladder_game=_is_ladder_game(ctx),
        game_version=getattr(ctx, "game_version", None),
        game_build=getattr(ctx, "game_build", None),
        opponent=opponent,
        build_log=[],
        early_build_log=[],
        opp_early_build_log=[],
        opp_build_log=[],
        started_at=(
            _to_iso(started_at_raw)
            if started_at_raw not in (None, "", "unknown")
            else None
        ),
        is_resumed_from_replay=True,
    )


def parse_replay_for_cloud(
    file_path: Path,
    *,
    player_handle: Optional[str] = None,
    state_dir: Optional[Path] = None,
    resolve_pulse: bool = True,
) -> Optional[CloudGame]:
    """Back-compat wrapper around :func:`parse_replay_for_cloud_ex`
    for callers that don't care WHY a replay was unusable."""
    game, _reason = parse_replay_for_cloud_ex(
        file_path,
        player_handle=player_handle,
        state_dir=state_dir,
        resolve_pulse=resolve_pulse,
    )
    return game


def parse_replay_for_cloud_ex(
    file_path: Path,
    *,
    player_handle: Optional[str] = None,
    state_dir: Optional[Path] = None,
    resolve_pulse: bool = True,
) -> tuple[Optional[CloudGame], Optional[str]]:
    """Parse one .SC2Replay and return ``(CloudGame, None)``, or
    ``(None, reason)`` when the replay is unusable — reason is one of
    the ``SKIP_*`` codes (AI game, unresolved player, no result, parse
    error) so the import-progress UI can tell the user something
    actionable instead of a bare failure count.

    ``player_handle`` is an optional explicit override (e.g. tests).
    Otherwise we resolve through ``state_dir``'s cached cloud value
    or the legacy env-var fallback. ``resolve_pulse=False`` is used by
    full-history workers: the stable toon handle still reaches the cloud,
    whose durable backfill resolves SC2Pulse identity later, without making
    every replay wait on an external network lookup. Fresh replay uploads
    keep the default ``True`` for immediate opponent enrichment.
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
        return None, SKIP_PARSE_FAILED

    # Capture this before identity recovery. A resumed artifact still needs
    # the same deterministic "who is me?" fallback as an ordinary replay so
    # we can produce the exact gameId an older agent used for this local file.
    is_resumed = bool(getattr(ctx, "is_resumed_from_replay", False)) or bool(
        getattr(getattr(ctx, "raw", None), "resume_from_replay", False)
    )

    if ctx.is_ai_game and not is_resumed:
        return None, SKIP_AI_GAME

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
                    return None, SKIP_PARSE_FAILED
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

                # The second parse is normally identical apart from player
                # identity, but recompute defensively in case a parser version
                # only surfaces its direct hijack-event evidence on this pass.
                is_resumed = is_resumed or bool(
                    getattr(ctx, "is_resumed_from_replay", False)
                ) or bool(
                    getattr(getattr(ctx, "raw", None),
                            "resume_from_replay", False)
                )

    if not ctx.me or not ctx.opponent:
        return None, SKIP_PLAYER_UNRESOLVED

    me = ctx.me
    opp = ctx.opponent
    if is_resumed:
        # Do not discard this locally. Older agents uploaded Resume/Take
        # Command artifacts as real wins/losses; Full Re-sync must send an
        # explicit marker for the same gameId so the cloud can quarantine the
        # already-stored row. Keep this payload deliberately shallow: no Pulse
        # lookup, MMR, macro, build, or spatial work is meaningful for a
        # synthetic replay branch.
        return _build_resumed_cloud_game(ctx, me, opp), None

    result = _result_str(me.result)
    if result is None:
        return None, SKIP_NO_RESULT

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
    # Compact map-playback payload for the cloud's vespene-style
    # replayer (unit movement tracks + buildings + battle markers).
    # Additive and best-effort like the spatial extract.
    map_playback = _compute_map_playback(ctx)

    is_ladder = _is_ladder_game(ctx)

    opponent = {
        "displayName": _sanitize_name(opp.name),
        "race": opp.race or "U",
    }
    if opp.mmr is not None:
        opponent["mmr"] = int(opp.mmr)
    # League banding signal for the cloud's ladder-meta / benchmark
    # aggregations (both filter on ``opponent.leagueId``). The parser
    # normalizes the replay's initData enum to 0=Bronze..6=Grandmaster
    # (core.sc2_replay_parser._get_player_league_id). Ladder games only:
    # the cloud treats the opponent's league as a proxy for the bracket
    # the game was played in, which matchmaking guarantees on ladder but
    # a custom lobby doesn't. Unknown (None) is trusted like elsewhere
    # in this function — old parses shouldn't drop the field.
    if is_ladder is not False and getattr(opp, "league_id", None) is not None:
        try:
            opponent["leagueId"] = int(opp.league_id)
        except (TypeError, ValueError):
            pass
    # Identity: keep the in-replay toon_handle as the storage key
    # (`pulseId`) so the existing per-opponent record stays stable even
    # when SC2Pulse is offline or the lookup misses. Always emit the
    # raw toon under `toonHandle`. Fresh uploads attempt SC2Pulse here;
    # full-history workers defer it to the cloud's durable backfill. The
    # server remains authoritative on whether to overwrite a stored
    # pulseCharacterId. Emit ``pulseLookupAttempted`` so the API/cron can
    # distinguish "agent didn't try" from "agent tried and Pulse said no".
    if opp.handle:
        opponent["toonHandle"] = str(opp.handle)
        opponent["pulseId"] = str(opp.handle)
        if resolve_pulse:
            pulse_character_id = _resolve_pulse_character_id(
                opp,
                file_path=file_path,
            )
            opponent["pulseLookupAttempted"] = True
            if pulse_character_id is not None:
                opponent["pulseCharacterId"] = pulse_character_id
        else:
            opponent["pulseLookupAttempted"] = False
    else:
        opponent["pulseLookupAttempted"] = False
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

    # Resolve the streamer's MMR through a layered fallback so the
    # session widget's Tier-1/Tier-2 fallbacks in
    # ``apps/api/src/services/games.js`` actually have a number to
    # pin to. The v0.5.5 attempt (`getattr(me, "scaled_rating", None)`)
    # was a no-op — ``me`` is a ``PlayerInfo`` dataclass that only
    # surfaces ``mmr``, never ``scaled_rating`` — so it always fell
    # through to the original ``me.mmr`` path and the streamer kept
    # seeing ``— MMR`` on the overlay. The new helper walks
    # ``ctx.raw.players`` directly so every supported sc2reader player
    # shape is covered while deep parsing stays at load_level=4 for
    # definitive Resume-from-Replay detection. One
    # INFO line per parse documents the resolution path so a streamer
    # grepping their agent log can see exactly which source supplied
    # (or didn't supply) their MMR.
    my_mmr = _resolve_my_mmr(ctx, me, file_path=file_path)

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

    # ``race`` is the concrete spawned race. Keep the queue selection
    # separately so Random's own ladder/MMR series is not attributed to
    # whichever race the replay happened to spawn.
    my_ladder_race_raw = (
        getattr(me, "selected_race", None)
        or getattr(me, "race", None)
    )
    started_at_raw = getattr(ctx, "started_at_iso", None)

    return CloudGame(
        game_id=str(ctx.game_id),
        date_iso=_to_iso(ctx.date_iso),
        result=result,
        my_race=str(me.race),
        my_ladder_race=(
            str(my_ladder_race_raw) if my_ladder_race_raw else None
        ),
        my_build=getattr(ctx, "my_build", None),
        map_name=str(ctx.map_name),
        duration_sec=int(ctx.length_seconds or 0),
        macro_score=macro_score_value,
        apm=getattr(me, "apm", None),
        spq=getattr(me, "spq", None),
        my_mmr=my_mmr,
        my_toon_handle=my_toon_handle,
        player_count=_player_count(ctx),
        match_format=_match_format(ctx),
        is_ladder_game=is_ladder,
        game_version=getattr(ctx, "game_version", None),
        game_build=getattr(ctx, "game_build", None),
        opponent=opponent,
        build_log=my_build_log,
        early_build_log=early_build_log,
        opp_early_build_log=opp_early_build_log,
        opp_build_log=opp_build_log,
        macro_breakdown=macro_breakdown,
        apm_curve=apm_curve,
        spatial=spatial,
        map_playback=map_playback,
        started_at=(
            _to_iso(started_at_raw)
            if started_at_raw not in (None, "", "unknown")
            else None
        ),
    ), None


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


# ── Map playback (the cloud's vespene-style replayer) ────────────────
#
# ``core.map_playback_data.build_playback_data`` walks the replay once
# and produces the full playback payload the offline map viewer uses:
# per-unit movement tracks (flat [t, x, y, …] waypoints), building
# events, per-side stats series, playable bounds, spawn locations and
# battle markers. ``_compact_map_playback`` reduces that to a bounded
# upload the cloud stores in the per-game detail blob and the web
# replayer renders. Caps below keep a worst-case 60-minute game to
# roughly a megabyte of JSON.

_PLAYBACK_MAX_UNITS_PER_SIDE = 500
_PLAYBACK_MAX_WAYPOINTS_PER_UNIT = 240
_PLAYBACK_MIN_WAYPOINT_GAP_SEC = 2.0
_PLAYBACK_MAX_BUILDINGS_PER_SIDE = 400
_PLAYBACK_STATS_STEP_SEC = 10.0
_PLAYBACK_MAX_BATTLES = 80
_PLAYBACK_MAX_RESOURCES = 600
_PLAYBACK_MAX_BUILDING_MOVES = 20


def _compute_map_playback(ctx: Any) -> Optional[Dict[str, Any]]:
    """Best-effort compact playback payload, or ``None``.

    Loads the ENGINE's ``core.map_playback_data`` via the package
    loader (its ``from .paths import …`` relative imports rule out the
    single-file loader), calls it with the documented
    ``(file_path, player_name)`` signature, and compacts the result.
    Every failure degrades to ``None`` — playback is additive and must
    never block an upload.
    """
    me = getattr(ctx, "me", None)
    replay_path = getattr(ctx, "file_path", None) or getattr(ctx, "replay_path", None)
    player_name = getattr(me, "name", None) if me is not None else None
    if not replay_path or not player_name:
        return None
    try:
        mod = _load_sc2ra_package_module("map_playback_data")
        build_playback = mod.build_playback_data
    except Exception as exc:  # noqa: BLE001
        log.warning("map_playback_imports_unavailable: %s", exc)
        return None
    try:
        playback = build_playback(str(replay_path), str(player_name))
    except Exception as exc:  # noqa: BLE001
        log.debug("map_playback_build_failed: %s", exc)
        return None
    if not playback:
        return None
    try:
        markers = []
        try:
            markers = mod.detect_battle_markers(
                playback.get("my_stats") or [],
                playback.get("opp_stats") or [],
                playback.get("my_events") or [],
                playback.get("opp_events") or [],
                float(playback.get("game_length") or 0.0),
            )
        except Exception:  # noqa: BLE001
            markers = []
        return _compact_map_playback(playback, markers)
    except Exception as exc:  # noqa: BLE001
        log.debug("map_playback_compact_failed: %s", exc)
        return None


def _compact_map_playback(
    playback: Mapping[str, Any],
    battle_markers: Optional[list] = None,
) -> Optional[Dict[str, Any]]:
    """Reduce a full playback dict to the bounded cloud upload shape.

    Pure function (no replay/file access) so tests can feed synthetic
    payloads. Output shape (camelCase, ready for the web replayer):

      {
        v: 4, mapName, gameLength,
        bounds: {minX, minY, maxX, maxY},
        spawns: [{owner: 'me'|'opp', x, y}],
        battles: [{t, x, y}],
        buildings: [{owner, name, t, x, y, moves?, died?}],
        units: [{owner, name, born, died|null, sd?, wp: [t,x,y,…]}],
        resources: [{kind, x, y, died?}],
        stats: {me: [[t, army, workers, supply]…], opp: […]}
      }

    ``sd`` (spent death, v4) is True when the unit's death event had no
    killer — a Drone morphing into a structure, Templar merging into an
    Archon, a MULE expiring — so the web's loss ledger can tell
    resources SPENT from resources LOST exactly instead of pairing
    deaths with building starts heuristically.
    """
    bounds_in = playback.get("bounds")
    if not isinstance(bounds_in, Mapping):
        return None
    try:
        bounds = {
            "minX": float(bounds_in.get("x_min", 0.0)),
            "minY": float(bounds_in.get("y_min", 0.0)),
            "maxX": float(bounds_in.get("x_max", 200.0)),
            "maxY": float(bounds_in.get("y_max", 200.0)),
        }
    except (TypeError, ValueError):
        return None
    if bounds["maxX"] <= bounds["minX"] or bounds["maxY"] <= bounds["minY"]:
        return None

    # v4 promises killer attribution on unit deaths (the ``sd`` flag
    # below). Only claim it when the engine actually provided the
    # ``killer_pid`` key — the web trusts v4 payloads exactly and skips
    # its heuristic morph detection, so a v4 payload WITHOUT attribution
    # would count every morphed drone as a combat loss.
    has_attribution = any(
        isinstance(u, Mapping) and "killer_pid" in u
        for key in ("my_units", "opp_units")
        for u in (playback.get(key) or [])
    )
    out: Dict[str, Any] = {
        # v4: units carry ``sd`` (killer-less death = spent, not lost);
        # v3 added building lift/land ``moves`` + ``died``; v2 added
        # ``resources`` (neutral mineral/gas/rock/tower nodes).
        "v": 4 if has_attribution else 3,
        "mapName": str(playback.get("map_name") or ""),
        "gameLength": float(playback.get("game_length") or 0.0),
        "bounds": bounds,
    }

    spawns = []
    for s in playback.get("spawn_locations") or []:
        if not isinstance(s, Mapping):
            continue
        owner = s.get("owner")
        x, y = s.get("x"), s.get("y")
        if owner in ("me", "opp") and isinstance(x, (int, float)) and isinstance(y, (int, float)):
            spawns.append({"owner": owner, "x": round(float(x), 1), "y": round(float(y), 1)})
    out["spawns"] = spawns[:8]

    battles = []
    for m in battle_markers or []:
        if not isinstance(m, Mapping):
            continue
        t, x, y = m.get("time"), m.get("x"), m.get("y")
        if all(isinstance(v, (int, float)) for v in (t, x, y)):
            battles.append({
                "t": round(float(t), 1),
                "x": round(float(x), 1),
                "y": round(float(y), 1),
            })
    out["battles"] = battles[:_PLAYBACK_MAX_BATTLES]

    resources: list = []
    for r in playback.get("resources") or []:
        if not isinstance(r, Mapping):
            continue
        kind = r.get("kind")
        x, y = r.get("x"), r.get("y")
        if kind not in ("minerals", "gold", "gas", "rocks", "tower"):
            continue
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        node: Dict[str, Any] = {
            "kind": kind,
            "x": round(float(x), 1),
            "y": round(float(y), 1),
        }
        died = r.get("died")
        if isinstance(died, (int, float)):
            node["died"] = round(float(died), 1)
        resources.append(node)
        if len(resources) >= _PLAYBACK_MAX_RESOURCES:
            break
    if resources:
        out["resources"] = resources

    buildings: list = []
    per_side_counts = {"me": 0, "opp": 0}
    # Prefer the tracker-derived lifecycle lists (exact born/died plus
    # lift-off landing points); fall back to the legacy build-event
    # scan for payloads produced by an older engine.
    has_lifecycle = bool(
        playback.get("my_buildings") or playback.get("opp_buildings"),
    )
    if has_lifecycle:
        for owner, key in (("me", "my_buildings"), ("opp", "opp_buildings")):
            for e in playback.get(key) or []:
                if not isinstance(e, Mapping):
                    continue
                x, y = e.get("x"), e.get("y")
                if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                    continue
                if per_side_counts[owner] >= _PLAYBACK_MAX_BUILDINGS_PER_SIDE:
                    continue
                per_side_counts[owner] += 1
                entry: Dict[str, Any] = {
                    "owner": owner,
                    "name": str(e.get("name") or ""),
                    "t": round(float(e.get("born") or 0.0), 1),
                    "x": round(float(x), 1),
                    "y": round(float(y), 1),
                }
                moves = e.get("moves")
                if isinstance(moves, (list, tuple)) and moves:
                    flat = [
                        round(float(v), 1)
                        for v in moves[:_PLAYBACK_MAX_BUILDING_MOVES * 3]
                        if isinstance(v, (int, float))
                    ]
                    if flat and len(flat) % 3 == 0:
                        entry["moves"] = flat
                died = e.get("died")
                if isinstance(died, (int, float)):
                    entry["died"] = round(float(died), 1)
                buildings.append(entry)
    else:
        for owner, key in (("me", "my_events"), ("opp", "opp_events")):
            for e in playback.get(key) or []:
                if not isinstance(e, Mapping) or e.get("type") != "building":
                    continue
                x, y = e.get("x"), e.get("y")
                if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                    continue
                if per_side_counts[owner] >= _PLAYBACK_MAX_BUILDINGS_PER_SIDE:
                    continue
                per_side_counts[owner] += 1
                buildings.append({
                    "owner": owner,
                    "name": str(e.get("name") or e.get("unit_type") or ""),
                    "t": round(float(e.get("time") or 0.0), 1),
                    "x": round(float(x), 1),
                    "y": round(float(y), 1),
                })
    out["buildings"] = buildings

    units: list = []
    for owner, key in (("me", "my_units"), ("opp", "opp_units")):
        side = [u for u in (playback.get(key) or []) if isinstance(u, Mapping)]
        # When over the cap, keep the longest-lived units — they carry
        # the story; blips (canceled eggs, one-shot units) go first.
        if len(side) > _PLAYBACK_MAX_UNITS_PER_SIDE:
            def _lifespan(u: Mapping[str, Any]) -> float:
                born = u.get("born") or 0.0
                died = u.get("died")
                end = died if isinstance(died, (int, float)) else float("inf")
                try:
                    return float(end) - float(born)
                except (TypeError, ValueError):
                    return 0.0
            side = sorted(side, key=_lifespan, reverse=True)[:_PLAYBACK_MAX_UNITS_PER_SIDE]
        for u in side:
            wp_in = u.get("waypoints") or []
            wp: list = []
            last_t = None
            # Waypoints arrive as [(t, x, y), …] tuples or a flat list.
            triples = (
                [wp_in[i : i + 3] for i in range(0, len(wp_in) - 2, 3)]
                if wp_in and isinstance(wp_in[0], (int, float))
                else wp_in
            )
            for tri in triples:
                try:
                    t, x, y = float(tri[0]), float(tri[1]), float(tri[2])
                except (TypeError, ValueError, IndexError):
                    continue
                if last_t is not None and t - last_t < _PLAYBACK_MIN_WAYPOINT_GAP_SEC:
                    continue
                if len(wp) >= _PLAYBACK_MAX_WAYPOINTS_PER_UNIT * 3:
                    break
                last_t = t
                wp.extend((round(t, 1), round(x, 1), round(y, 1)))
            if not wp:
                continue
            born = u.get("born")
            died = u.get("died")
            entry: Dict[str, Any] = {
                "owner": owner,
                "name": str(u.get("name") or ""),
                "born": round(float(born), 1) if isinstance(born, (int, float)) else round(wp[0], 1),
                "died": round(float(died), 1) if isinstance(died, (int, float)) else None,
                "wp": wp,
            }
            # Spent death: the engine attributed this death and found no
            # killer (drone→structure morph, templar→archon merge, MULE
            # timeout). Only emitted when the engine provided the key —
            # older bundled engines can't tell, and absence must stay
            # distinguishable from "killed by the opponent".
            if entry["died"] is not None and "killer_pid" in u and u.get("killer_pid") is None:
                entry["sd"] = True
            units.append(entry)
    out["units"] = units

    stats_out: Dict[str, list] = {}
    for owner, key in (("me", "my_stats"), ("opp", "opp_stats")):
        rows: list = []
        last_t = -1e9
        for s in playback.get(key) or []:
            if not isinstance(s, Mapping):
                continue
            t = s.get("time")
            if not isinstance(t, (int, float)):
                continue
            if float(t) - last_t < _PLAYBACK_STATS_STEP_SEC:
                continue
            last_t = float(t)
            rows.append([
                round(float(t), 1),
                int(s.get("army_val") or 0),
                int(s.get("workers") or 0),
                int(s.get("food_used") or 0),
            ])
        stats_out[owner] = rows
    out["stats"] = stats_out

    if not units and not buildings:
        return None
    return out


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
        # Pin to apps/replay-engine's copies — see _load_sc2ra_module
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
        # apps/replay-engine extractor returns them under
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
    # sc2reader's PlayerStatsEvent fires every ~10 s. We bucket at the
    # same cadence so the chart hover snaps to every native sample —
    # users scrubbing the Active Army timeline get a reading every 10 s
    # of game time instead of every 30 s. Each sample is ~24 bytes on
    # the wire, so a 30 min game adds ~4 kB per side vs. the old 30 s
    # cadence — well within the 5000-entry maxItems cap (≥13 h of
    # game time). The macro_score above already ran against the full
    # stream so nothing scoring-side is affected.
    my_stats_full = list(my_macro.get("stats_events") or [])
    my_stats_ds = _downsample_stats_events(my_stats_full)
    opp_stats_ds = _downsample_stats_events(opp_stats)
    # Match unit_timeline against the downsampled my-stats sample times
    # so the SPA's chart hover and unit-composition snapshot land on
    # the SAME ticks as the army/worker lines.
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
        # Structure lifetimes ({name, unit_id, born_time, died_time})
        # for BOTH sides. The SPA's Buildings roster subtracts
        # destroyed structures using these records
        # (deriveBuildingComposition in compositionAt.ts); without
        # them it falls back to the cumulative build-order count and
        # killed spines / spores / cannons never leave the roster.
        # ``bases`` / ``opp_bases`` are the town-hall subset the API's
        # phase classifier and scouting surfaces prefer. Each record
        # is ~5 small fields, bounded by structures-built-per-game
        # (~100s), so the wire cost is a few kB per game.
        "production_buildings": list(
            my_macro.get("production_buildings") or []),
        "opp_production_buildings": list(
            my_macro.get("opp_production_buildings") or []),
        "bases": list(my_macro.get("bases") or []),
        "opp_bases": list(my_macro.get("opp_bases") or []),
        "player_stats": _build_player_stats_summary(
            ctx, my_macro, score_raw or {},
        ),
    }
    derived: Optional[float] = None
    if isinstance(macro_score_val, (int, float)):
        derived = float(macro_score_val)
    return payload, derived


# How wide each ``stats_events`` retention bucket is, in game-time
# seconds. 10 s matches sc2reader's native PlayerStatsEvent cadence so
# the chart hover snaps to every emitted sample. The constant is
# module-level so tests can import + assert against it.
_STATS_EVENTS_BUCKET_SEC = 10


def _downsample_stats_events(events: list) -> list:
    """Keep one ``stats_events`` entry per ``_STATS_EVENTS_BUCKET_SEC``
    game-time bucket.

    Input is sc2reader's ~10 s-cadence ``PlayerStatsEvent`` rows;
    output is the FIRST event in each bucket. We keep the first rather
    than averaging because each row is already a snapshot of cumulative
    state (food_used, minerals_current, etc.) — averaging would smooth
    meaningful spikes (a temporary mineral float, a burst of unspent
    gas) that the user cares about. Empty input returns an empty list;
    a None input is also handled.
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
    # ``event.second`` from sc2reader 1.8.0 is ``frame // 16`` — the
    # HotS-era 16fps scale — so reading it directly would put every
    # bucket 1.4× too high on a LotV replay. Resolve the real
    # frame-rate once via ``infer_fps`` and convert frames ourselves.
    try:
        from core.timebase import infer_fps  # type: ignore
        fps = infer_fps(replay)
    except Exception:  # noqa: BLE001
        fps = 22.4
    for ev in events:
        pid = getattr(ev, "pid", None)
        if pid is None:
            player = getattr(ev, "player", None)
            pid = getattr(player, "pid", None) if player else None
        if pid not in (me_pid, opp_pid):
            continue
        frame = getattr(ev, "frame", None)
        if frame is None:
            # Some game events don't expose frame; their ``second``
            # is still on sc2reader's broken 16fps scale, so rescale
            # it to real time the same way ``timebase.event_seconds``
            # does in its frame-less fallback path.
            sec_attr = getattr(ev, "second", None)
            if sec_attr is None:
                continue
            try:
                sec = int(round(float(sec_attr) * 16.0 / fps))
            except (TypeError, ValueError):
                continue
        else:
            try:
                sec = int(round(int(frame) / fps))
            except (TypeError, ValueError):
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
      * env override ``SC2TOOLS_PULSE_TIMEOUT_SEC`` (single value
        applied to BOTH live and backfill) wins when set
      * else, if the replay is recent (mtime within 30 min), 30 s
        — full live-game budget
      * else either ``SC2TOOLS_PULSE_BACKFILL_TIMEOUT_SEC`` (env
        override for the older-replay branch) or the default
        backfill cap (10 s).

    The backfill default was bumped from 4 s to 10 s in May 2026:
    the previous 4 s cap was tight enough that a legitimate-but-slow
    SC2Pulse response (the API regularly takes 6–8 s under load)
    registered as a miss on every catch-up scan, which together with
    the in-process negative cache meant opponents never got their
    pulseCharacterId resolved even when the player WAS resolvable.

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
    backfill_raw = os.environ.get("SC2TOOLS_PULSE_BACKFILL_TIMEOUT_SEC", "").strip()
    if backfill_raw:
        try:
            n = float(backfill_raw)
            if n >= 0:
                return n
        except ValueError:
            pass
    return 10.0


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


# Bounds used to reject league enums (Bronze=0..Grandmaster=7) and
# obviously-bad reads. The upper limit matches the API game schema so
# a corrupt replay cannot leave an otherwise valid upload retrying a
# permanently rejected payload.
_MIN_PLAUSIBLE_MMR = 500
_MAX_PLAUSIBLE_MMR = 9999


def _coerce_plausible_mmr(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not (_MIN_PLAUSIBLE_MMR <= value <= _MAX_PLAUSIBLE_MMR):
        return None
    return int(value)


def _resolve_my_mmr(
    ctx: Any, me: Any, *, file_path: Path,
) -> Optional[int]:
    """Return the streamer's MMR for the cloud upload, or None.

    Layered fallback so a single missing source doesn't blank the
    session widget for a whole sync window:

      1. ``PlayerInfo.mmr`` — already prefers ``scaled_rating`` then
         ``mmr`` via ``core.sc2_replay_parser._get_player_mmr``. Cleanest
         path; fires for every replay sc2reader parsed at load_level=4
         where the local player carries the tracker-event MMR.
      2. Raw sc2reader player object on ``ctx.raw.players``. Pinned
         sc2reader 1.8.0 stores the decoded value at
         ``player.init_data["scaled_rating"]`` without promoting it to
         ``player.scaled_rating``; patched/newer builds may expose a
         top-level attribute, so both shapes are supported. Probe both
         attributes directly rather than depending on wrapper promotion.
         Deep parsing remains at level 4 so the game-event stream cannot
         lose its definitive Resume-from-Replay marker.

    A single INFO log line documents which layer hit (or that none did)
    so a streamer grepping their agent log can see exactly why the
    overlay says ``—`` without flipping log_level=DEBUG.
    """
    # Layer 1: PlayerInfo wrapper.
    cached = getattr(me, "mmr", None)
    cached_mmr = _coerce_plausible_mmr(cached)
    if cached_mmr is not None:
        log.info(
            "my_mmr_resolved file=%s source=PlayerInfo value=%d",
            file_path.name, cached_mmr,
        )
        return cached_mmr

    # Layer 2: raw sc2reader player. Match by toon_handle (worldwide
    # unique) first, falling back to pid (unique within a single replay)
    # if the wrapper somehow lost the handle field.
    raw_replay = getattr(ctx, "raw", None)
    if raw_replay is None:
        log.info(
            "my_mmr_unresolved file=%s reason=no_raw_replay "
            "playerinfo_mmr=%r",
            file_path.name, cached,
        )
        return None
    raw_match = _find_raw_player(
        raw_replay,
        handle=getattr(me, "handle", None),
        pid=getattr(me, "pid", None),
    )
    if raw_match is None:
        log.info(
            "my_mmr_unresolved file=%s reason=raw_player_not_found "
            "handle=%r pid=%r playerinfo_mmr=%r",
            file_path.name,
            getattr(me, "handle", None),
            getattr(me, "pid", None),
            cached,
        )
        return None
    init_data = getattr(raw_match, "init_data", None)
    nested = init_data if isinstance(init_data, Mapping) else {}
    for source, val in (
        ("raw_player.scaled_rating", getattr(raw_match, "scaled_rating", None)),
        ("raw_player.init_data.scaled_rating", nested.get("scaled_rating")),
        ("raw_player.mmr", getattr(raw_match, "mmr", None)),
        ("raw_player.init_data.mmr", nested.get("mmr")),
    ):
        mmr = _coerce_plausible_mmr(val)
        if mmr is not None:
            log.info(
                "my_mmr_resolved file=%s source=%s value=%d",
                file_path.name, source, mmr,
            )
            return mmr
    log.info(
        "my_mmr_unresolved file=%s reason=raw_attrs_unset "
        "scaled_rating=%r init_scaled_rating=%r raw_mmr=%r "
        "init_mmr=%r playerinfo_mmr=%r",
        file_path.name,
        getattr(raw_match, "scaled_rating", None),
        nested.get("scaled_rating"),
        getattr(raw_match, "mmr", None),
        nested.get("mmr"),
        cached,
    )
    return None


def _find_raw_player(
    raw_replay: Any,
    *,
    handle: Optional[str],
    pid: Optional[int],
) -> Optional[Any]:
    """Find the raw sc2reader player matching a PlayerInfo's identity.

    Prefer ``toon_handle`` (worldwide-unique Battle.net character id)
    over ``pid`` (unique within a single replay only). Returns the first
    match, or None when ``raw_replay.players`` carries no player matching
    either identifier.
    """
    players = getattr(raw_replay, "players", None) or []
    if handle:
        handle_str = str(handle)
        for raw_player in players:
            if str(getattr(raw_player, "toon_handle", "") or "") == handle_str:
                return raw_player
    if pid is not None:
        for raw_player in players:
            if getattr(raw_player, "pid", None) == pid:
                return raw_player
    return None


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
