"""Explicit engine replay capture used by the web map's rebuild action."""
from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger(__name__)
CAPTURE_START_NOTICE = (
    "Accurate replay capture is starting on this PC. StarCraft II may use substantial CPU "
    "for several minutes. Turn off Accurate replay capture in Settings > Map replay to stop it."
)


class ReplayCaptureDisabled(RuntimeError):
    code = "replay_capture_disabled"


def replay_capture_enabled(state_dir: Optional[Path]) -> bool:
    """Only a durable explicit true grants permission to start StarCraft."""
    if state_dir is None:
        return False
    try:
        from .state import load_state
        return getattr(load_state(state_dir), "replay_capture_enabled", False) is True
    except Exception:
        return False


def _require_capture_enabled(state_dir: Optional[Path]) -> None:
    if not replay_capture_enabled(state_dir):
        raise ReplayCaptureDisabled(
            "Local replay capture is disabled. Enable Accurate replay capture in the agent's "
            "Settings > Map replay to allow StarCraft II to use this PC's CPU for accurate replay capture. "
            "Ordinary replay syncing and saved recordings still work."
        )


def configure_observation_cache(state_dir: Optional[Path]) -> None:
    if state_dir is not None:
        os.environ.setdefault("SC2TOOLS_OBSERVATION_DIR", str(Path(state_dir) / "replay-observations"))


def _reusable_recording(path: Path, my_pid: int, exporter, *, version: dict) -> Optional[dict]:
    """Reuse complete raw observations, never a compacted or partial upload."""
    digest = exporter.replay_digest(path)
    candidates = [path.with_name(path.name + ".observations.json")]
    cache = os.environ.get("SC2TOOLS_OBSERVATION_DIR")
    if cache:
        candidates.insert(0, Path(cache) / (digest + ".json"))
    for candidate in candidates:
        try:
            if not candidate.is_file() or candidate.stat().st_size > exporter.MAX_ARTIFACT_BYTES:
                continue
            # Bound the read as well as stat; another process may replace it.
            with candidate.open("rb") as recording:
                encoded = recording.read(exporter.MAX_ARTIFACT_BYTES + 1)
            if len(encoded) > exporter.MAX_ARTIFACT_BYTES:
                continue
            artifact = json.loads(encoded)
            if (artifact.get("artifactVersion") != exporter.ARTIFACT_VERSION
                    or artifact.get("replaySha256") != digest or artifact.get("myPid") != my_pid
                    or artifact.get("baseBuild") != version["baseBuild"]
                    or artifact.get("dataVersion") != version["dataVersion"]):
                continue
            observed = artifact.get("playback", {})
            fidelity = observed.get("fidelity", {})
            interval = fidelity.get("sampleSeconds")
            if (fidelity.get("complete") is not True or fidelity.get("positions") != "engine"
                    or fidelity.get("paths") != "observed"
                    or any(fidelity.get(channel) != "observed" for channel in ("attacks", "effects", "creep"))
                    or isinstance(interval, bool) or not isinstance(interval, (float, int))
                    or not math.isfinite(interval) or not 0 < interval <= 0.179
                    or "positionError" in fidelity):
                continue
            if not all(isinstance(observed.get(key), list) for key in (
                    "my_units", "opp_units", "my_buildings", "opp_buildings", "effects")):
                continue
            if not isinstance(observed.get("creep"), dict) or not isinstance(observed["creep"].get("frames"), list):
                continue
            return artifact
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return None


def _prepare_capture(path: Path, state_dir: Optional[Path]):
    from .replay_pipeline import (
        _load_sc2ra_package_module, _read_player_handle, _resolve_by_toon,
        _toon_handle_from_path,
    )

    configure_observation_cache(state_dir)
    parser = _load_sc2ra_package_module("sc2_replay_parser")
    ctx = parser.parse_deep(str(path), _read_player_handle(state_dir) or "")
    me = getattr(ctx, "me", None)
    if me is None:
        toon = _toon_handle_from_path(path)
        if toon:
            me, _opp = _resolve_by_toon(getattr(ctx, "all_players", []) or [], toon)
    if me is None or not getattr(me, "pid", None):
        raise ValueError("Set your StarCraft player name in Settings before rebuilding this replay.")
    exporter = _load_sc2ra_package_module("sc2_observation_export")
    try:
        metadata = json.loads(ctx.raw.archive.read_file("replay.gamemetadata.json"))
        base, data_version = metadata.get("BaseBuild"), str(metadata.get("DataVersion", "")).upper()
        if not isinstance(base, str) or not re.fullmatch(r"Base\d+", base) or not re.fullmatch(r"[A-F0-9]{32}", data_version):
            raise ValueError("invalid replay version")
        version = {"baseBuild": int(base[4:]), "dataVersion": data_version}
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        raise ValueError("The replay does not contain usable StarCraft engine version metadata.") from exc
    return me, exporter, version


def capture_request_allowed(path: Path, state_dir: Optional[Path]) -> bool:
    """Fast dispatch gate; a candidate is validated inside the rebuild thread.

    A cache hint grants no permission to launch SC2. Avoid parsing the whole
    replay before the socket acknowledgement; capture_exact_replay does that
    once and still rejects invalid cache entries when local capture is off.
    """
    if replay_capture_enabled(state_dir):
        return True
    try:
        configure_observation_cache(state_dir)
        limit = 128 * 1024 * 1024
        adjacent = path.with_name(path.name + ".observations.json")
        if adjacent.is_file() and 0 < adjacent.stat().st_size <= limit:
            return True
        cache = os.environ.get("SC2TOOLS_OBSERVATION_DIR")
        if cache:
            # Replays are small; hashing their bytes needs no parser imports.
            import hashlib
            digest = hashlib.sha256()
            with path.open("rb") as replay:
                for block in iter(lambda: replay.read(1024 * 1024), b""):
                    digest.update(block)
            candidate = Path(cache) / (digest.hexdigest() + ".json")
            return candidate.is_file() and 0 < candidate.stat().st_size <= limit
        return False
    except Exception:
        return False


def capture_exact_replay(path: Path, state_dir: Optional[Path], progress: Optional[Callable] = None,
                         *, notify_start: Optional[Callable[[str], None]] = None) -> Path:
    """Reuse a valid recording, or capture only while explicit opt-in remains on.

    Ordinary replay parsing merely reads the cached artifact and never starts
    StarCraft. A web request is not permission to enable this local setting.
    """
    try:
        me, exporter, version = _prepare_capture(path, state_dir)
    except Exception:
        _require_capture_enabled(state_dir)
        raise
    artifact = _reusable_recording(path, me.pid, exporter, version=version)
    if artifact is None:
        _require_capture_enabled(state_dir)
        if progress:
            progress(CAPTURE_START_NOTICE)
        if notify_start:
            try:
                notify_start(CAPTURE_START_NOTICE)
            except Exception:
                log.exception("replay_capture_notification_failed")
        _require_capture_enabled(state_dir)
        # Checking a large agent.json on every observation is wasteful. Poll
        # the durable preference at most once per second; the exporter
        # also monitors it while blocked waiting for an SC2 API response.
        next_check, signature = 0.0, None
        cancelled = False
        check_lock = threading.Lock()

        def cancel_requested():
            nonlocal next_check, cancelled, signature
            with check_lock:
                now = time.monotonic()
                if not cancelled and now >= next_check:
                    from .state import STATE_FILENAME
                    try:
                        stat = (Path(state_dir) / STATE_FILENAME).stat() if state_dir else None
                        current = (stat.st_mtime_ns, stat.st_size, stat.st_ino) if stat else None
                    except OSError:
                        current = None
                    if current is None or current != signature:
                        cancelled = not replay_capture_enabled(state_dir)
                        signature = current
                    next_check = now + 1.0
                return cancelled

        try:
            artifact = exporter.export_engine_observations(path, me.pid, progress=progress,
                                                           cancel_requested=cancel_requested)
        except Exception as exc:
            if cancel_requested():
                raise ReplayCaptureDisabled(
                    "Local replay capture was stopped because it was turned off in Settings. "
                    "The previous playback was preserved."
                ) from exc
            raise
    elif progress:
        progress("Using the complete saved recording; StarCraft does not need to start again.")
    if artifact.get("playback", {}).get("fidelity", {}).get("complete") is not True:
        raise ValueError("The StarCraft replay could not be observed through the end of the game.")
    # Process-pool parsers may have started before this request changed the
    # parent environment. The adjacent atomic sidecar is discoverable by all
    # workers, including those that did not inherit our cache environment.
    output = path.with_name(path.name + ".observations.json")
    exporter.write_observation_artifact(artifact, output)
    cache = os.environ.get("SC2TOOLS_OBSERVATION_DIR")
    if cache:
        exporter.write_observation_artifact(artifact, Path(cache) / (exporter.replay_digest(path) + ".json"))
    return output


def wait_for_replay_upload(path: Path, state_dir: Optional[Path], previous_marker, *, timeout_seconds: float = 120, poll_seconds: float = 0.5) -> None:
    """Wait on durable upload outcomes; report rejections or stalls promptly."""
    from .state import load_state
    if state_dir is None:
        raise RuntimeError("The desktop agent cannot track this upload. Restart the agent and retry.")
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        state = load_state(state_dir)
        if state.paused:
            raise RuntimeError("Replay syncing is paused. Resume syncing in the desktop agent, then retry.")
        marker = state.uploaded.get(str(path))
        if marker == "rejected":
            raise RuntimeError("The server rejected the rebuilt replay. Update the desktop agent and retry.")
        if marker == "filtered":
            raise RuntimeError("The agent's sync date filter excludes this replay. Include its date in Settings, then retry.")
        if marker == "skipped:playback_budget_exceeded":
            raise RuntimeError(
                "This replay exceeds the upload capacity for accurate playback. "
                "The recording and previous playback were preserved. "
                "A higher-capacity playback format is required; repeating the recording will not fix this limit.")
        if isinstance(marker, str) and marker.startswith("skipped"):
            raise RuntimeError("The agent could not parse the rebuilt replay for upload. Check your player name and agent replay log, then retry.")
        if marker and marker != previous_marker:
            return
        time.sleep(poll_seconds)
    raise TimeoutError("The replay was recorded, but its upload has not completed. Check the agent's connection and sync status; it will continue retrying the upload.")
