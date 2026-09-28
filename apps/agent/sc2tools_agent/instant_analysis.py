"""Sandbox entry point for Instant Analysis (the in-browser replay engine).

The web app runs this module inside Pyodide. It hands over the raw bytes of
one ``.SC2Replay`` and gets back exactly the game payload the desktop agent
would upload for the same bytes, perspective and engine data files.

Nothing here re-implements payload logic. :func:`parse_replay_bytes` writes
the bytes to a real file under a fresh temporary directory (the engine
re-opens the replay by path for map playback) and calls the UNCHANGED
:func:`sc2tools_agent.replay_pipeline.parse_replay_for_cloud_ex` with the
sandbox settings: no state dir, no SC2Pulse lookups (so no threads or
sockets), and no local engine observation artifacts. The desktop agent keeps
calling ``parse_replay_for_cloud_ex`` directly and never goes through here.

Every return value is JSON-serialisable plain data so it can cross the Web
Worker boundary. Failure envelopes never contain player names or file paths.
Zip expansion, digests and temp-file staging live in ``instant_intake`` and
are re-exported here so the worker only imports this module.

Example (needs a real replay file, so not a doctest)::

    from sc2tools_agent.instant_analysis import RuntimeOptions, parse_replay_bytes
    data = open("game.SC2Replay", "rb").read()
    result = parse_replay_bytes(data, filename="game.SC2Replay",
                                runtime=RuntimeOptions(player_toon="1-S2-1-267727"))
    result["ok"], result["gameId"]
    # -> (True, '2026-05-08T19:08:12|Squirtuoz|Tourmaline LE|470')
"""

from __future__ import annotations

import contextlib
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from . import replay_pipeline
from .instant_intake import (  # noqa: F401 - re-exported public API
    MAX_ZIP_ENTRY_BYTES,
    MAX_ZIP_REPLAY_ENTRIES,
    MAX_ZIP_TOTAL_BYTES,
    ZIP_ENCRYPTED,
    ZIP_ENTRY_TOO_LARGE,
    ZIP_INVALID,
    ZIP_TOO_LARGE,
    ZIP_TOO_MANY_ENTRIES,
    ZIP_UNSUPPORTED,
    BytesLike,
    as_bytes,
    clean_path_parts,
    expand_replay_zip,
    replay_digests,
    staged_replay,
)
from .upload_json import compact_json_bytes

# Importing replay_pipeline put apps/replay-engine on sys.path. The
# classifier is pure (no sc2reader import), so a bundle that lacks it fails
# loudly at boot instead of mid-batch.
from core import replay_errors  # type: ignore

log = logging.getLogger(__name__)

#: Version of the Python <-> worker message shapes defined here. Must match
#: ``ENGINE_PROTOCOL`` in ``apps/web/lib/instant/engineVersion.ts``.
ENGINE_PROTOCOL = 1

# Error kinds emitted by this module. Wire contract with the ``ErrorKind``
# union in ``apps/web/lib/instant/types.ts``.
ERROR_UNSUPPORTED_VERSION = "unsupported_version"
ERROR_CORRUPT_FILE = "corrupt_file"
ERROR_NOT_A_REPLAY = "not_a_replay"
ERROR_AI_GAME = "ai_game"
ERROR_PLAYER_UNRESOLVED = "player_unresolved"
ERROR_PLAYER_AMBIGUOUS = "player_ambiguous"
ERROR_NO_RESULT = "no_result"
ERROR_PARSE_FAILED = "parse_failed"
ERROR_ANALYSIS_FAILED = "analysis_failed"
ERROR_PLAYBACK_BUDGET_EXCEEDED = "playback_budget_exceeded"
ERROR_ENGINE_UNAVAILABLE = "engine_unavailable"

#: Dotted payload paths that may legitimately differ between a desktop-agent
#: upload and a browser upload of the SAME bytes, perspective and engine data
#: files. Anything else differing is a parity bug. Keep this minimal.
RUNTIME_ONLY_FIELDS: Tuple[str, ...] = (
    # Desktop live lane passes resolve_pulse=True; the sandbox never calls SC2Pulse, so it is always False here.
    "opponent.pulseLookupAttempted",
    # Network result from SC2Pulse on the desktop; absent in the sandbox (the cloud backfills it).
    "opponent.pulseCharacterId",
    # Desktop upload queue adds legacy gameId aliases from its local path_by_game_id state.
    "resumedReplayGameIds",
    # A local engine observation artifact upgrades playback fidelity; with a
    # state_dir the desktop may omit it entirely in favour of R2 segments.
    "mapPlayback",
    # Taken from the engine-merged playback bounds when a local observation artifact exists.
    "spatial.map_bounds",
    # Battle markers are re-derived from engine-merged playback when a local observation artifact exists.
    "spatial.battles",
    # Death markers come from the same engine-merged playback as spatial.battles.
    "spatial.deaths",
)

# Pipeline skip reasons that pass through unchanged as the error kind, with
# their fixed detail text. "playback_budget_exceeded" is a literal in
# parse_replay_for_cloud_ex rather than a SKIP_* constant.
_PASS_THROUGH_REASONS: Dict[str, str] = {
    replay_pipeline.SKIP_AI_GAME: "Games against the A.I. are not uploaded.",
    replay_pipeline.SKIP_PLAYER_UNRESOLVED: "Could not determine which player is you.",
    replay_pipeline.SKIP_NO_RESULT: "The replay has no win, loss or tie for your player.",
    ERROR_PLAYBACK_BUDGET_EXCEEDED: "The game analysis exceeds the upload size limit.",
}

# Fixed detail texts: never interpolate exception messages (they can carry
# local paths) or player names.
_TEXT_NOT_A_REPLAY = "The file does not start with an MPQ archive header."
_TEXT_LOAD_FAILED = "the replay could not be loaded."
_TEXT_ANALYSIS_AFTER_LOAD = "The replay loads, but the deep analysis failed."
_TEXT_ANALYSIS_RAISED = "the analysis raised an unexpected error."
_TEXT_ENGINE_MISSING = "the replay engine could not be imported."
_TEXT_TOON_NOT_FOUND = "No player in the replay has the requested toon handle."
_TEXT_AMBIGUOUS = "The requested toon matched a different player's display name."
_TEXT_UNKNOWN_SKIP = "The analysis pipeline skipped the replay."
_TEXT_STAGING_FAILED = "the replay could not be staged in the sandbox filesystem."
_TEXT_NO_PLAYERS = "The replay archive opens, but its player list is missing or unreadable."

# First bytes of an SC2 replay: MPQ user-data header (0x1b) or a bare MPQ
# archive header (0x1a).
_MPQ_MAGICS: Tuple[bytes, ...] = (b"MPQ\x1b", b"MPQ\x1a")
_MPQ_MAGIC_LEN = 4

# sc2reader load levels: 4 is what parse_deep uses; 0 reads only the MPQ
# archive and the self-describing replay header.
_DEEP_LOAD_LEVEL = 4
_HEADER_LOAD_LEVEL = 0

# Base name every replay is staged under (see _neutral_staging_name).
_STAGED_REPLAY_NAME = "replay.SC2Replay"

_PLAYER_RESULTS = frozenset({"Win", "Loss", "Tie"})
_UNKNOWN_DATE = "unknown"
_MS_PER_SECOND = 1000

# Env vars the desktop pipeline consults at call time. Masked while this
# module runs so nothing outside the bytes can influence the payload.
_MASKED_ENV_VARS: Tuple[str, ...] = (
    "SC2TOOLS_OBSERVATION_DIR",  # engine_capture: cached engine observation artifacts
    "SC2TOOLS_PLAYER_HANDLE",  # file_caches: legacy env handle fallback
    "SC2TOOLS_PLAYER_CONFIG",  # file_caches: legacy player-config JSON path
)

_CAPABILITY_FLAGS: Tuple[str, ...] = (
    "threads",
    "file_caches",
    "network_lookups",
    "engine_capture",
)

Envelope = Dict[str, Any]
_Analyse = Callable[[Path, Path], Envelope]


@dataclass(frozen=True)
class RuntimeOptions:
    """Perspective and capability settings for one sandbox parse.

    Attributes:
        player_handle: Display-name substring (desktop-agent semantics:
            case-sensitive, first matching player wins).
        player_toon: Exact toon handle such as ``1-S2-1-267727``. Preferred
            over ``player_handle`` and verified against the payload's
            ``myToonHandle`` after the parse.
        threads: Must stay False: the sandbox cannot start threads.
        file_caches: Must stay False: no state dir, handle cache or env
            handle lookups.
        network_lookups: Must stay False: no SC2Pulse lookups.
        engine_capture: Must stay False: no local engine observation
            artifacts.

    The capability flags exist so callers state the sandbox contract
    explicitly; :func:`parse_replay_bytes` rejects any True flag. The desktop
    agent, which has those capabilities, calls
    ``replay_pipeline.parse_replay_for_cloud_ex`` instead.

    Example:
        >>> RuntimeOptions(player_toon="1-S2-1-267727").network_lookups
        False
    """

    player_handle: Optional[str] = None
    player_toon: Optional[str] = None
    threads: bool = False
    file_caches: bool = False
    network_lookups: bool = False
    engine_capture: bool = False


#: The only runtime the browser uses: no perspective hint, no capabilities.
BROWSER_RUNTIME = RuntimeOptions()


def parse_replay_bytes(
    data: BytesLike,
    *,
    filename: str,
    runtime: RuntimeOptions = BROWSER_RUNTIME,
) -> Envelope:
    """Parse one replay's bytes into the desktop agent's upload payload.

    Args:
        data: The raw ``.SC2Replay`` bytes (``bytearray`` / ``memoryview``
            are accepted and copied).
        filename: Name or relative path the file had on the user's device,
            for example ``Accounts/1/1-S2-1-267727/Replays/Multiplayer/x.SC2Replay``.
            Only a toon folder in it is recreated under a fresh temp dir, so
            it identifies the player exactly like on the desktop; the other
            names never reach the sandbox filesystem or any log line.
        runtime: Perspective selection. Capability flags must all be False.

    Returns:
        ``{"ok": True, "gameId", "json", "payload", "date", "myToonHandle",
        "matchFormat", "isResumedFromReplay"}`` where ``json`` is the exact
        ASCII upload text of ``payload``; or ``{"ok": False, "reason",
        "errorKind", "detail"}``. Resumed replays are returned as ok with
        ``isResumedFromReplay`` True; upload policy is the caller's.

    Raises:
        ValueError: A capability flag in ``runtime`` is True.
        TypeError: ``data`` is not bytes-like.

    Example:
        >>> parse_replay_bytes(b"", filename="x.SC2Replay")["errorKind"]
        'not_a_replay'
    """
    _require_sandbox_runtime(runtime)
    blob = as_bytes(data)
    started = time.perf_counter()
    if not _looks_like_mpq(blob):
        result = _failure(ERROR_NOT_A_REPLAY, ERROR_NOT_A_REPLAY, _TEXT_NOT_A_REPLAY)
    else:
        result = _run_staged(blob, filename, lambda path, _rel: _parse_staged(path, runtime))
    _log_outcome("instant_parse_done", result, started, len(blob))
    return result


def list_replay_players(data: BytesLike, *, filename: str) -> Envelope:
    """Read the players and header facts of a replay (cheap, load level 2).

    Used to ask "which player are you?" and to pre-filter by date before the
    full parse. Reuses ``core.sc2_replay_parser.parse_live`` and the
    pipeline's own ``_match_format`` / ``_player_count`` /
    ``_toon_handle_from_path`` so the answers match the desktop agent.

    Args:
        data: The raw ``.SC2Replay`` bytes.
        filename: Name or relative path on the user's device (see
            :func:`parse_replay_bytes`); drives ``toonFromPath``.

    Returns:
        ``{"ok": True, "players": [{"name", "toon", "race", "result",
        "pid"}], "date", "map", "durationSec", "matchFormat", "playerCount",
        "isAiGame", "toonFromPath"}`` (humans and A.I., observers and
        referees excluded; ``date`` is None when the replay has no valid
        timestamp) or ``{"ok": False, "errorKind", "detail"}``.

    Example:
        >>> list_replay_players(b"text", filename="x.SC2Replay")["errorKind"]
        'not_a_replay'
    """
    blob = as_bytes(data)
    started = time.perf_counter()
    if not _looks_like_mpq(blob):
        result = _players_failure(
            _failure(ERROR_NOT_A_REPLAY, ERROR_NOT_A_REPLAY, _TEXT_NOT_A_REPLAY),
        )
    else:
        result = _run_staged(blob, filename, _list_staged)
    _log_outcome("instant_players_done", result, started, len(blob))
    return result


# ---------------------------------------------------------------------------
# Sandbox plumbing
# ---------------------------------------------------------------------------
def _require_sandbox_runtime(runtime: RuntimeOptions) -> None:
    """Reject capability flags this sandbox entry point cannot honour."""
    enabled = [flag for flag in _CAPABILITY_FLAGS if getattr(runtime, flag)]
    if enabled:
        raise ValueError(
            "instant_analysis is the sandbox entry point and runs without "
            f"{', '.join(enabled)}; every RuntimeOptions capability flag must "
            "be False. The desktop agent path is "
            "replay_pipeline.parse_replay_for_cloud_ex.",
        )


def _looks_like_mpq(blob: bytes) -> bool:
    return blob[:_MPQ_MAGIC_LEN] in _MPQ_MAGICS


@contextlib.contextmanager
def _sandbox_environment() -> Iterator[None]:
    """Hide the env vars that could feed local state into the payload.

    Not thread-safe (``os.environ`` is process-global); the sandbox is
    single-threaded by contract.
    """
    saved = {name: os.environ.pop(name) for name in _MASKED_ENV_VARS if name in os.environ}
    try:
        yield
    finally:
        os.environ.update(saved)


def _neutral_staging_name(filename: str) -> str:
    """Stage as ``[<toon>/]replay.SC2Replay``: all the engine reads of a path.

    The pipeline's only use of the path is its toon-folder fallback
    (``_toon_handle_from_path``: first toon-shaped part, root to leaf), so
    keeping just that folder preserves desktop behaviour exactly. The user's
    own file and folder names never reach the sandbox filesystem, and so
    never reach a log line or exception text (the unchanged pipeline logs
    ``file_path.name``; sc2reader logs the full path). The payload does not
    depend on the name: the golden ``pathVariants`` all produce identical JSON.
    """
    toons = (replay_pipeline._toon_handle_from_path(Path(part)) for part in clean_path_parts(filename))
    toon = next((found for found in toons if found), None)
    return f"{toon}/{_STAGED_REPLAY_NAME}" if toon else _STAGED_REPLAY_NAME


def _run_staged(blob: bytes, filename: str, analyse: _Analyse) -> Envelope:
    """Run ``analyse`` on the staged replay with the sandbox environment."""
    staged_name = _neutral_staging_name(filename)
    try:
        with _sandbox_environment(), staged_replay(blob, staged_name) as (path, relative):
            return analyse(path, relative)
    except OSError as exc:
        # Writing the temp file (disk full, MEMFS limit, a name the host
        # filesystem rejects). analyse() converts its own failures.
        return _failure(
            ERROR_ANALYSIS_FAILED,
            ERROR_ANALYSIS_FAILED,
            f"{type(exc).__name__}: {_TEXT_STAGING_FAILED}",
        )


def _failure(reason: str, error_kind: str, detail: str) -> Envelope:
    return {"ok": False, "reason": reason, "errorKind": error_kind, "detail": detail}


def _players_failure(failure: Envelope) -> Envelope:
    return {"ok": False, "errorKind": failure["errorKind"], "detail": failure["detail"]}


def _engine_unavailable(exc: BaseException) -> Envelope:
    return _failure(
        ERROR_ENGINE_UNAVAILABLE,
        ERROR_ENGINE_UNAVAILABLE,
        f"{type(exc).__name__}: {_TEXT_ENGINE_MISSING}",
    )


def _log_outcome(event: str, result: Envelope, started: float, size: int) -> None:
    """One structured INFO line per call; never names or paths."""
    elapsed_ms = int((time.perf_counter() - started) * _MS_PER_SECOND)
    log.info(
        "%s ok=%s error_kind=%s elapsed_ms=%d size_bytes=%d",
        event,
        result.get("ok"),
        result.get("errorKind"),
        elapsed_ms,
        size,
    )


# ---------------------------------------------------------------------------
# parse_replay_bytes internals
# ---------------------------------------------------------------------------
def _parse_staged(path: Path, runtime: RuntimeOptions) -> Envelope:
    """Pick the perspective, run the unchanged pipeline, map the outcome."""
    handle, failure = _select_player_handle(path, runtime)
    if failure is not None:
        return failure
    try:
        game, reason = replay_pipeline.parse_replay_for_cloud_ex(
            path,
            player_handle=handle,
            state_dir=None,
            resolve_pulse=False,
        )
        if game is None:
            return _skip_failure(reason, path)
        return _success(game.to_payload(), runtime)
    except replay_pipeline.AnalyzerImportError as exc:
        return _engine_unavailable(exc)
    except SystemExit as exc:
        # core/event_extractor.py and core/replay_loader.py call sys.exit(1)
        # when sc2reader is missing. SystemExit is a BaseException, so it
        # escapes the pipeline's own ``except Exception`` import guard; in a
        # worker it would end the interpreter instead of failing one file.
        return _engine_unavailable(exc)
    except Exception as exc:
        # Same contract as the desktop watcher (watcher.py maps any
        # unexpected pipeline exception to analysis_failed): one bad replay
        # must never take down the batch. KeyboardInterrupt is left alone so
        # a worker interrupt still cancels.
        log.warning("instant_parse_exception error_class=%s", type(exc).__name__)
        log.debug("instant_parse_exception_detail", exc_info=True)
        return _failure(
            ERROR_ANALYSIS_FAILED,
            ERROR_ANALYSIS_FAILED,
            f"{type(exc).__name__}: {_TEXT_ANALYSIS_RAISED}",
        )


def _select_player_handle(
    path: Path,
    runtime: RuntimeOptions,
) -> Tuple[Optional[str], Optional[Envelope]]:
    """Return (player_handle for the pipeline, failure envelope or None).

    ``player_toon`` wins over ``player_handle``. With neither, the pipeline
    gets ``None`` and falls back to the toon folder in the path, exactly
    like the desktop agent.
    """
    if runtime.player_toon:
        return _name_for_toon(path, runtime.player_toon)
    return (runtime.player_handle or None), None


def _name_for_toon(path: Path, toon: str) -> Tuple[Optional[str], Optional[Envelope]]:
    """Resolve an exact toon handle to the player's in-replay display name."""
    ctx, failure = _parse_live(path)
    if failure is not None:
        return None, failure
    for player in _listed_players(ctx):
        handle = getattr(player, "handle", None)
        name = getattr(player, "name", None)
        if handle and str(handle) == toon and name:
            return str(name), None
    return None, _failure(
        replay_pipeline.SKIP_PLAYER_UNRESOLVED,
        ERROR_PLAYER_UNRESOLVED,
        _TEXT_TOON_NOT_FOUND,
    )


def _parse_live(path: Path) -> Tuple[Any, Optional[Envelope]]:
    """Run ``parse_live(path, "")``; return (ctx, None) or (None, failure).

    A replay with no listed player is reported as ``corrupt_file``: every
    real game has at least one player, and sc2reader still "loads" an
    archive whose hash/block tables are damaged, just without
    ``replay.details``.
    """
    try:
        from core.sc2_replay_parser import parse_live  # type: ignore
    # Import failures of any kind (including the engine's sys.exit(1) when
    # sc2reader is missing) mean the engine is not usable in this runtime.
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        return None, _engine_unavailable(exc)
    try:
        ctx = parse_live(str(path), "")
    except SystemExit as exc:
        # A lazily imported engine module found sc2reader missing.
        return None, _engine_unavailable(exc)
    # Any sc2reader load error is classified from the bytes, not re-raised.
    except Exception as exc:  # noqa: BLE001
        return None, _load_failure(path, exc)
    if not _listed_players(ctx):
        return None, _failure(
            replay_pipeline.SKIP_PARSE_FAILED,
            ERROR_CORRUPT_FILE,
            _TEXT_NO_PLAYERS,
        )
    return ctx, None


def _listed_players(ctx: Any) -> List[Any]:
    """``ctx.all_players`` minus observers/referees (as ``_resolve_by_toon``)."""
    return [
        player
        for player in (getattr(ctx, "all_players", None) or [])
        if not getattr(player, "is_observer", False)
        and not getattr(player, "is_referee", False)
    ]


def _skip_failure(reason: Optional[str], path: Path) -> Envelope:
    """Map a ``(None, reason)`` pipeline result to a failure envelope."""
    if reason == replay_pipeline.SKIP_PARSE_FAILED:
        return _classify_parse_failure(path)
    if reason == replay_pipeline.SKIP_PLAYER_UNRESOLVED:
        return _classify_unresolved_player(path)
    if reason in _PASS_THROUGH_REASONS:
        return _failure(reason, reason, _PASS_THROUGH_REASONS[reason])
    return _failure(reason or ERROR_ANALYSIS_FAILED, ERROR_ANALYSIS_FAILED, _TEXT_UNKNOWN_SKIP)


def _classify_parse_failure(path: Path) -> Envelope:
    """Name the cause of ``parse_failed`` (failure path only: one re-load).

    The pipeline swallows the ``parse_deep`` exception, so the replay is
    loaded again exactly the way ``parse_deep`` loads it.
    """
    from core.sc2_replay_parser import _load_replay  # type: ignore

    try:
        _load_replay(str(path), _DEEP_LOAD_LEVEL)
    # Any sc2reader load error is what we are here to classify.
    except Exception as exc:  # noqa: BLE001
        return _load_failure(path, exc)
    return _failure(
        replay_pipeline.SKIP_PARSE_FAILED,
        ERROR_ANALYSIS_FAILED,
        _TEXT_ANALYSIS_AFTER_LOAD,
    )


def _classify_unresolved_player(path: Path) -> Envelope:
    """``player_unresolved``, unless the replay has no readable players at all.

    Failure path only: one cheap load-level-2 read. A damaged archive with
    no player list would otherwise tell the user "we could not find you".
    """
    _ctx, failure = _parse_live(path)
    if failure is not None and failure["errorKind"] == ERROR_CORRUPT_FILE:
        return _failure(replay_pipeline.SKIP_PLAYER_UNRESOLVED, ERROR_CORRUPT_FILE, failure["detail"])
    reason = replay_pipeline.SKIP_PLAYER_UNRESOLVED
    return _failure(reason, reason, _PASS_THROUGH_REASONS[reason])


def _load_failure(path: Path, exc: BaseException) -> Envelope:
    """Classify a load exception into corrupt / unsupported / parse_failed."""
    kind = replay_errors.classify_load_failure(
        exc,
        header_readable=_header_readable(path),
    )
    return _failure(
        replay_pipeline.SKIP_PARSE_FAILED,
        kind,
        f"{type(exc).__name__}: {_TEXT_LOAD_FAILED}",
    )


def _header_readable(path: Path) -> bool:
    """True when the MPQ archive and the replay header decode (level 0)."""
    try:
        import sc2reader  # type: ignore

        sc2reader.load_replay(str(path), load_level=_HEADER_LOAD_LEVEL)
    # Any failure at level 0 means the archive or header bytes are damaged.
    except Exception:  # noqa: BLE001
        return False
    return True


def _success(payload: Envelope, runtime: RuntimeOptions) -> Envelope:
    """Build the ok envelope, verifying the requested toon when given."""
    my_toon = payload.get("myToonHandle")
    if runtime.player_toon and my_toon != runtime.player_toon:
        # parse_deep matched the display name as a substring and picked a
        # different player whose name contains the requested one.
        return _failure(ERROR_PLAYER_AMBIGUOUS, ERROR_PLAYER_AMBIGUOUS, _TEXT_AMBIGUOUS)
    return {
        "ok": True,
        "gameId": str(payload["gameId"]),
        "json": compact_json_bytes(payload).decode("ascii"),
        "payload": payload,
        "date": str(payload["date"]),
        "myToonHandle": my_toon,
        "matchFormat": payload.get("matchFormat"),
        "isResumedFromReplay": payload.get("isResumedFromReplay") is True,
    }


# ---------------------------------------------------------------------------
# list_replay_players internals
# ---------------------------------------------------------------------------
def _list_staged(path: Path, relative: Path) -> Envelope:
    ctx, failure = _parse_live(path)
    if failure is not None:
        return _players_failure(failure)
    return {
        "ok": True,
        "players": [_player_entry(player) for player in _listed_players(ctx)],
        "date": _replay_date_or_none(getattr(ctx, "date_iso", None)),
        "map": getattr(ctx, "map_name", "") or None,
        "durationSec": int(getattr(ctx, "length_seconds", 0) or 0),
        "matchFormat": replay_pipeline._match_format(ctx),
        "playerCount": int(replay_pipeline._player_count(ctx) or 0),
        "isAiGame": bool(getattr(ctx, "is_ai_game", False)),
        # Relative path only: the temp root must never masquerade as a toon.
        "toonFromPath": replay_pipeline._toon_handle_from_path(relative),
    }


def _player_entry(player: Any) -> Envelope:
    handle = getattr(player, "handle", None)
    result = getattr(player, "result", None)
    return {
        "name": str(getattr(player, "name", "") or ""),
        "toon": str(handle) if handle else None,
        "race": str(getattr(player, "race", "") or ""),
        "result": result if result in _PLAYER_RESULTS else None,
        "pid": int(getattr(player, "pid", 0) or 0),
    }


def _replay_date_or_none(date_iso: Any) -> Optional[str]:
    """``replay_pipeline._to_iso`` for a valid date, else None (never now())."""
    if not isinstance(date_iso, str) or not date_iso or date_iso == _UNKNOWN_DATE:
        return None
    normalized = date_iso if "T" in date_iso else date_iso.replace(" ", "T")
    try:
        datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None
    return replay_pipeline._to_iso(date_iso)
