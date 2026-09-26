"""Versioned, bounded playback segments. Native observation caches stay immutable.

Tracks retain original samples bracketing each window, so seeking reproduces the
same interpolation/hold semantics. Lifetime skeletons preserve whole-game HUD
counts without retaining whole-game motion in the browser.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

from .upload_json import compact_json_bytes

MAX_SEGMENT_BYTES = 2 * 1024 * 1024
MAX_SEGMENT_POINTS = 60_000
MAX_SEGMENTS = 512
MANIFEST_SCHEMA = "sc2tools-playback-manifest-v1"
SEGMENT_SCHEMA = "sc2tools-playback-segment-v1"


def source_artifact_digest(replay_path, playback):
    """Hash the matching immutable native file, not a reserialized derivative."""
    candidates = [replay_path.with_name(replay_path.name + ".observations.json")]
    if os.environ.get("SC2TOOLS_OBSERVATION_DIR"):
        candidates.insert(0, Path(os.environ["SC2TOOLS_OBSERVATION_DIR"]) / (playback["replaySha256"] + ".json"))
    for path in candidates:
        try:
            if path.stat().st_size > 256 * 1024 * 1024:
                continue
            with path.open("rb") as handle:
                body = handle.read(256 * 1024 * 1024 + 1)
            if len(body) > 256 * 1024 * 1024:
                continue
            source = json.loads(body)
            if (source.get("replaySha256") == playback["replaySha256"]
                    and source.get("myPid") == playback.get("me_pid")
                    and source.get("playback", {}).get("fidelity", {}).get("complete") is True):
                return hashlib.sha256(body).hexdigest()
        except (OSError, ValueError):
            continue
    raise ValueError("Matching native observation artifact is unavailable")


def _track_window(values, start, end, *, flat=False):
    rows = [values[i:i + 3] for i in range(0, len(values), 3)] if flat else values
    if not rows:
        return []
    times = [row[0] for row in rows]
    first = max(0, bisect_left(times, start) - 1)
    last = min(len(rows), bisect_right(times, end) + 1)
    kept = rows[first:last]
    return [v for row in kept for v in row] if flat else kept


def slice_playback(playback, start, end):
    """Pure bounded view; no native objects or coordinates are mutated."""
    final = end >= playback["game_length"]
    inside = lambda t: start <= t and (t < end or (final and t <= end))
    out = dict(playback)
    for key in ("my_units", "opp_units", "my_buildings", "opp_buildings"):
        records = []
        for source in playback.get(key) or []:
            record = dict(source)
            alive = source.get("born", 0) <= end and (source.get("died") is None or source["died"] >= start)
            for field in ("waypoints", "moves"):
                values = source.get(field) or []
                flat = field == "moves" or bool(values and isinstance(values[0], (int, float)))
                record[field] = (_track_window(values, start, end, flat=flat) if alive
                                 else values[:3 if flat else 1])
            record["attacks"] = [t for t in source.get("attacks") or [] if inside(t)]
            aim = source.get("aim") or []
            record["aim"] = [v for i in range(0, len(aim), 3) if inside(aim[i]) for v in aim[i:i + 3]]
            records.append(record)
        out[key] = records
    out["ability_casts"] = [c for c in playback.get("ability_casts") or [] if inside(c["t"])]
    out["effects"] = [e for e in playback.get("effects") or [] if e["t"] <= end and e["end"] >= start]
    creep = playback.get("creep")
    if isinstance(creep, dict):
        frames = creep.get("frames") or []
        first = max(0, bisect_right([f["t"] for f in frames], start) - 1)
        out["creep"] = {**creep, "frames": [f for f in frames[first:] if f["t"] <= end]}
    return out


def build_bundle(playback, directory: Path, *, source_sha256: str, battle_markers=None):
    """Write content-addressed segments plus a manifest, published last.

    A failed attempt leaves only harmless reusable chunks; no existing manifest,
    observation artifact or replay is replaced. No SC2 process is started.
    """
    from .replay_pipeline import PlaybackBudgetExceeded, _compact_map_playback

    replay_sha = playback.get("replaySha256")
    if not isinstance(replay_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", replay_sha):
        raise ValueError("Segmented playback requires verified replay identity")
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256):
        raise ValueError("Segmented playback requires source artifact identity")
    fidelity = playback.get("fidelity") or {}
    if fidelity.get("positions") != "engine" or fidelity.get("complete") is not True:
        raise ValueError("Only complete engine observations may become segmented playback")
    length = playback.get("game_length")
    if not isinstance(length, (int, float)) or not math.isfinite(length) or not 0 < length <= 86400:
        raise ValueError("Invalid playback duration")
    directory.mkdir(parents=True, exist_ok=True)
    segments = []
    max_error = 0.0

    def write_window(start, end):
        nonlocal max_error
        if len(segments) >= MAX_SEGMENTS:
            raise PlaybackBudgetExceeded("Playback needs more than 512 bounded segments")
        try:
            compact = _compact_map_playback(slice_playback(playback, start, end), battle_markers,
                                           max_bytes=MAX_SEGMENT_BYTES - 2048,
                                           terminal_attack_inclusive=True)
            if not compact or compact.get("fidelity", {}).get("complete") is not True:
                raise ValueError("Incomplete source cannot be published as a complete segment")
            for record in compact["units"] + compact["buildings"]:
                if len(record.get("forms", [])) > 512 or len(record.get("hidden", [])) > 16384:
                    raise ValueError("Playback lifecycle metadata exceeds browser capacity")
            if any(len(rows) > 800 for rows in compact.get("stats", {}).values()):
                raise ValueError("Playback statistics exceed browser capacity")
            if len(compact.get("effects", [])) > 10000 or len(compact.get("creep", {}).get("frames", [])) > 12000:
                raise PlaybackBudgetExceeded("Playback effects need a smaller time window")
            points = sum(len(u.get("wp", [])) // 3 for u in compact["units"])
            points += sum(len(b.get("moves", [])) // 3 for b in compact["buildings"])
            item = {"schema": SEGMENT_SCHEMA, "replaySha256": replay_sha,
                    "index": len(segments), "start": start, "end": end, "playback": compact}
            body = compact_json_bytes(item)
            if points > MAX_SEGMENT_POINTS or len(body) > MAX_SEGMENT_BYTES:
                raise PlaybackBudgetExceeded("Segment needs a smaller time window")
        except PlaybackBudgetExceeded:
            if end - start < 1:
                raise
            middle = round((start + end) / 2, 6)
            write_window(start, middle)
            write_window(middle, end)
            return
        digest = hashlib.sha256(body).hexdigest()
        _write_immutable(directory / f"{digest}.json", body)
        segments.append({"index": len(segments), "start": start, "end": end,
                         "sizeBytes": len(body), "sha256": digest, "points": points})
        max_error = max(max_error, compact["fidelity"].get("positionError", 0))

    start = 0
    while start < length:
        end = min(length, start + 60)
        write_window(start, end)
        start = end
    manifest = {"schema": MANIFEST_SCHEMA, "replaySha256": replay_sha,
                "sourceArtifactSha256": source_sha256, "mapName": str(playback.get("map_name") or ""),
                "gameLength": length, "fidelity": {**fidelity, "positionError": max_error},
                "segments": segments}
    body = compact_json_bytes(manifest)
    manifest_path = directory / f"manifest-{hashlib.sha256(body).hexdigest()}.json"
    _write_immutable(manifest_path, body)
    return manifest_path


def _write_immutable(path, body):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix="segment-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Atomic publication without replacing any existing cache entry.
            os.link(temporary, path)
        except FileExistsError:
            if path.read_bytes() != body:
                raise ValueError("Existing playback bundle bytes do not match their digest")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_bundle(path):
    path = Path(path)
    if path.stat().st_size > 200_000:
        raise ValueError("Playback manifest exceeds capacity")
    with path.open("rb") as handle:
        body = handle.read(200_001)
    if len(body) > 200_000:
        raise ValueError("Playback manifest exceeds capacity")
    manifest = json.loads(body)
    if manifest.get("schema") != MANIFEST_SCHEMA or not 0 < len(manifest.get("segments", [])) <= MAX_SEGMENTS:
        raise ValueError("Invalid playback manifest")
    if manifest.get("fidelity", {}).get("complete") is not True:
        raise ValueError("Incomplete playback bundle")
    for key in ("replaySha256", "sourceArtifactSha256"):
        if not isinstance(manifest.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", manifest[key]):
            raise ValueError("Invalid playback source identity")
    end = 0
    for index, descriptor in enumerate(manifest["segments"]):
        if (descriptor.get("index") != index or descriptor.get("start") != end
                or not isinstance(descriptor.get("end"), (float, int))
                or not math.isfinite(descriptor["end"]) or descriptor["end"] <= end
                or not isinstance(descriptor.get("sizeBytes"), int) or not 0 < descriptor["sizeBytes"] <= MAX_SEGMENT_BYTES
                or not isinstance(descriptor.get("points"), int) or not 0 <= descriptor["points"] <= MAX_SEGMENT_POINTS
                or not isinstance(descriptor.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", descriptor["sha256"])):
            raise ValueError("Invalid playback segment descriptor")
        end = descriptor["end"]
    if end != manifest.get("gameLength") or end > 86400:
        raise ValueError("Incomplete playback time coverage")
    return manifest


def has_engine_playback(game, *, allow_reduced_legacy=False):
    path = getattr(game, "playback_artifact_path", None)
    if path:
        try:
            fidelity = load_bundle(path)["fidelity"]
        except (OSError, ValueError, KeyError):
            return False
    else:
        fidelity = (getattr(game, "map_playback", None) or {}).get("fidelity", {})
    interval = fidelity.get("sampleSeconds")
    return (isinstance(interval, (int, float)) and not isinstance(interval, bool)
            and math.isfinite(interval) and 0 < interval <= 0.179
            and fidelity.get("positions") == "engine"
            and (fidelity.get("complete") is True or (allow_reduced_legacy and not path))
            and all(fidelity.get(channel) == "observed" for channel in ("attacks", "effects", "creep")))
