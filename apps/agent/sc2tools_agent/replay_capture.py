"""Explicit engine replay capture used by the web map's rebuild action."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable, Optional


def configure_observation_cache(state_dir: Optional[Path]) -> None:
    if state_dir is not None:
        os.environ.setdefault("SC2TOOLS_OBSERVATION_DIR", str(Path(state_dir) / "replay-observations"))


def _reusable_recording(path: Path, my_pid: int, exporter) -> Optional[dict]:
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
                    or artifact.get("replaySha256") != digest or artifact.get("myPid") != my_pid):
                continue
            observed = artifact.get("playback", {})
            fidelity = observed.get("fidelity", {})
            interval = fidelity.get("sampleSeconds")
            if (fidelity.get("complete") is not True or fidelity.get("positions") != "engine"
                    or any(fidelity.get(channel) != "observed" for channel in ("attacks", "effects", "creep"))
                    or not isinstance(interval, (float, int)) or not 0 < interval <= 0.179
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


def capture_exact_replay(path: Path, state_dir: Optional[Path], progress: Optional[Callable] = None) -> Path:
    """Resolve the normal upload perspective, capture, and atomically cache.

    This runs only after an explicit engine rebuild request. Ordinary replay
    parsing merely reads the cached artifact and does not launch StarCraft.
    """
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
    artifact = _reusable_recording(path, me.pid, exporter)
    if artifact is None:
        artifact = exporter.export_engine_observations(path, me.pid, progress=progress)
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
