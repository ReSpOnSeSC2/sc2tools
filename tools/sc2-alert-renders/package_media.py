#!/usr/bin/env python3
"""Package one Blender-rendered SC2 alert sequence for the web overlay."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Mapping, Sequence


PREFIX = "[sc2-alert-package]"


class PackageError(RuntimeError):
    """An actionable packaging failure."""


def log(message: str) -> None:
    print(f"{PREFIX} {message}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--delivery-root", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def read_manifest(path: Path, spec_id: str) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    if not path.is_file():
        raise PackageError(f"Render manifest was not found: {path}")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PackageError(f"Could not read render manifest {path}: {exc}") from exc
    if manifest.get("schemaVersion") != 1:
        raise PackageError(f"Unsupported manifest schemaVersion in {path}; expected 1.")
    matches = [spec for spec in manifest.get("specs", []) if spec.get("id") == spec_id]
    if len(matches) != 1:
        raise PackageError(f"Expected exactly one manifest spec named {spec_id!r}; found {len(matches)}.")
    defaults = manifest.get("defaults", {})
    if not isinstance(defaults, Mapping) or not isinstance(matches[0], Mapping):
        raise PackageError("Manifest defaults/spec entries must be objects.")
    return defaults, matches[0]


def require_sources(
    input_root: Path, defaults: Mapping[str, Any], spec: Mapping[str, Any]
) -> tuple[Path, Path, int]:
    source = input_root / str(spec["id"])
    poster = source / "poster.png"
    frames_root = source / "frames"
    fidelity_report = source / "effect-realization.json"
    if not fidelity_report.is_file():
        raise PackageError(
            f"Effect fidelity ledger is missing for {spec['id']!r}: {fidelity_report}. "
            "Re-render with the current strict pipeline; calibration/bypass output cannot be packaged."
        )
    try:
        fidelity = json.loads(fidelity_report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PackageError(f"Could not read effect fidelity ledger {fidelity_report}: {exc}") from exc
    if (
        fidelity.get("schemaVersion") != 1
        or fidelity.get("specId") != spec["id"]
        or fidelity.get("ready") is not True
    ):
        unresolved = [
            f"{row.get('role')}/{row.get('effectClass')}={row.get('unresolvedCount')}"
            for row in fidelity.get("effectGate", [])
            if isinstance(row, Mapping) and row.get("ready") is not True
        ]
        detail = ", ".join(unresolved) or "ledger is invalid or not ready"
        raise PackageError(
            f"Effect fidelity gate is not ready for {spec['id']!r}: {detail}. "
            "Do not package -AllowUnsupportedEffects calibration output."
        )
    frames = sorted(frames_root.glob("frame_*.png"))
    if not poster.is_file():
        raise PackageError(f"Poster is missing for {spec['id']!r}: {poster}")
    frame_start = int(defaults.get("frameStart", 1))
    expected = int(spec["frameEnd"]) - frame_start + 1
    expected_names = [f"frame_{number:04d}.png" for number in range(frame_start, int(spec["frameEnd"]) + 1)]
    actual_names = [path.name for path in frames]
    if actual_names != expected_names:
        raise PackageError(
            f"Expected the complete contiguous {expected}-frame sequence for {spec['id']!r} under {frames_root}; "
            f"found {len(frames)} frame(s). Render the full sequence before packaging."
        )
    return poster, frames_root, frame_start


def run_ffmpeg(executable: Path, arguments: Sequence[str], label: str) -> None:
    command = [str(executable), "-hide_banner", "-loglevel", "warning", *arguments]
    completed = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        output = "\n".join(completed.stdout.strip().splitlines()[-30:])
        raise PackageError(f"FFmpeg failed while {label} (exit {completed.returncode}):\n{output}")
    if completed.stdout.strip():
        log(completed.stdout.strip())


def encode_poster(ffmpeg: Path, source: Path, destination: Path) -> None:
    partial = destination.with_name(f"{destination.stem}.partial{destination.suffix}")
    partial.unlink(missing_ok=True)
    run_ffmpeg(
        ffmpeg,
        (
            "-y",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-c:v",
            "libwebp",
            "-lossless",
            "0",
            "-quality",
            "92",
            "-compression_level",
            "6",
            str(partial),
        ),
        f"encoding poster {source.name}",
    )
    if not partial.is_file():
        raise PackageError(f"FFmpeg did not create the WebP poster: {partial}")
    os.replace(partial, destination)
    log(f"Wrote poster {destination}.")


def encode_video(
    ffmpeg: Path,
    frames_root: Path,
    frame_start: int,
    fps: int,
    destination: Path,
) -> None:
    partial = destination.with_name(f"{destination.stem}.partial{destination.suffix}")
    partial.unlink(missing_ok=True)
    run_ffmpeg(
        ffmpeg,
        (
            "-y",
            "-framerate",
            str(fps),
            "-start_number",
            str(frame_start),
            "-i",
            str(frames_root / "frame_%04d.png"),
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-crf",
            "27",
            "-b:v",
            "0",
            "-deadline",
            "good",
            "-cpu-used",
            "2",
            "-row-mt",
            "1",
            "-auto-alt-ref",
            "0",
            "-metadata:s:v:0",
            "alpha_mode=1",
            str(partial),
        ),
        f"encoding alpha WebM from {frames_root}",
    )
    if not partial.is_file():
        raise PackageError(f"FFmpeg did not create the WebM animation: {partial}")
    os.replace(partial, destination)
    log(f"Wrote alpha WebM {destination}.")


def validate_alpha(
    ffmpeg: Path,
    source: Path,
    expected_frames: int,
    *,
    decoder: str | None = None,
) -> None:
    """Decode delivery media and prove transparent + opaque alpha survived."""

    decoder_arguments = ["-c:v", decoder] if decoder else []
    completed = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            *decoder_arguments,
            "-i",
            str(source),
            "-vf",
            "alphaextract,signalstats,metadata=print:file=-",
            "-f",
            "null",
            "-",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        output = "\n".join(completed.stdout.strip().splitlines()[-30:])
        raise PackageError(f"Alpha validation failed to decode {source} (exit {completed.returncode}):\n{output}")
    minimums = [int(value) for value in re.findall(r"(?m)^lavfi\.signalstats\.YMIN=(\d+)$", completed.stdout)]
    maximums = [int(value) for value in re.findall(r"(?m)^lavfi\.signalstats\.YMAX=(\d+)$", completed.stdout)]
    if len(minimums) != expected_frames or len(maximums) != expected_frames:
        raise PackageError(
            f"Alpha validation decoded {len(minimums)} frame(s) from {source}; expected {expected_frames}."
        )
    alpha_min = min(minimums)
    alpha_max = max(maximums)
    if alpha_min != 0 or alpha_max != 255:
        raise PackageError(
            f"Alpha validation for {source} found aggregate range {alpha_min}..{alpha_max}; expected 0..255."
        )
    log(f"Validated {expected_frames} alpha frame(s) at aggregate range 0..255 for {source}.")


def main() -> int:
    args = parse_args()
    ffmpeg = args.ffmpeg.resolve()
    if not ffmpeg.is_file():
        raise PackageError(f"FFmpeg executable was not found: {ffmpeg}")
    defaults, spec = read_manifest(args.manifest.resolve(), args.spec)
    poster, frames_root, frame_start = require_sources(args.input_root.resolve(), defaults, spec)
    fps = int(defaults.get("fps", 24))
    if fps < 1 or fps > 60:
        raise PackageError(f"Manifest fps must be between 1 and 60; received {fps}.")
    delivery_root = args.delivery_root.resolve()
    delivery_root.mkdir(parents=True, exist_ok=True)
    base_name = str(spec.get("deliveryBaseName") or f"{spec['id']}-3d")
    webp = delivery_root / f"{base_name}.webp"
    webm = delivery_root / f"{base_name}.webm"
    existing = [path for path in (webp, webm) if path.exists()]
    if existing and not args.force:
        raise PackageError(
            "Delivery output already exists; use a fresh directory or pass --force: "
            + ", ".join(str(path) for path in existing)
        )

    encode_poster(ffmpeg, poster, webp)
    encode_video(ffmpeg, frames_root, frame_start, fps, webm)
    validate_alpha(ffmpeg, webp, 1)
    validate_alpha(
        ffmpeg,
        webm,
        int(spec["frameEnd"]) - frame_start + 1,
        decoder="libvpx-vp9",
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PackageError as exc:
        log(f"ERROR: {exc}")
        raise SystemExit(2) from exc
