#!/usr/bin/env python3
"""Build lightweight YouTube VOD review assets and an importable b-roll library.

This module intentionally uses only the Python standard library.  Media work is
delegated to the repository's yt-dlp and imageio-ffmpeg executables so the
workflow stays reproducible and does not depend on a system PATH.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import parse_qs, urlparse


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REVIEW_DIR = REPO_ROOT / ".tmp" / "broll-review"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
CLIP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
MAX_CLIPS = 100
MAX_TIMESTAMP_SECONDS = 86_400
MAX_TITLE_LENGTH = 120


class BrollError(RuntimeError):
    """A concise, user-actionable CLI error."""


@dataclass(frozen=True)
class Vod:
    video_id: str
    title: str
    clips: list[dict[str, Any]]
    source_url: str


def extract_video_id(value: str) -> str:
    """Return an 11-character ID from an ID or common YouTube URL."""

    candidate = value.strip()
    if VIDEO_ID_RE.fullmatch(candidate):
        return candidate

    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    video_id = ""
    if host == "youtu.be":
        video_id = next((part for part in parsed.path.split("/") if part), "")
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        video_id = parse_qs(parsed.query).get("v", [""])[0]
        if not video_id:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"embed", "live", "shorts", "v"}:
                video_id = parts[1]

    if not VIDEO_ID_RE.fullmatch(video_id):
        raise BrollError(f"Invalid YouTube video ID or URL: {value!r}")
    return video_id


def _manifest_items(document: Any) -> list[Any]:
    if isinstance(document, list):
        return document
    if isinstance(document, dict):
        for key in ("videos", "vods"):
            if key in document:
                if not isinstance(document[key], list):
                    raise BrollError(f"Manifest field {key!r} must be an array.")
                return document[key]
    raise BrollError("Manifest must be an array or an object containing a videos array.")


def load_manifest(path: Path) -> list[Vod]:
    """Load the simple source manifest or a generated review manifest."""

    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise BrollError(f"Manifest not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise BrollError(f"Invalid JSON in {path}: line {exc.lineno}, column {exc.colno}") from exc

    vods: list[Vod] = []
    seen: set[str] = set()
    for index, raw in enumerate(_manifest_items(document), start=1):
        if isinstance(raw, str):
            source = raw
            title = ""
            clips: list[dict[str, Any]] = []
        elif isinstance(raw, dict):
            source = str(raw.get("videoId") or raw.get("id") or raw.get("url") or "")
            title = str(raw.get("title") or "").strip()
            raw_clips = raw.get("clips", [])
            if not isinstance(raw_clips, list) or not all(isinstance(c, dict) for c in raw_clips):
                raise BrollError(f"Video {index} clips must be an array of objects.")
            clips = list(raw_clips)
        else:
            raise BrollError(f"Video {index} must be a video ID, URL, or object.")

        try:
            video_id = extract_video_id(source)
        except BrollError as exc:
            raise BrollError(f"Video {index}: {exc}") from exc
        if video_id in seen:
            raise BrollError(f"Video {index}: duplicate video ID {video_id}.")
        seen.add(video_id)
        vods.append(
            Vod(
                video_id=video_id,
                title=title,
                clips=clips,
                source_url=f"https://www.youtube.com/watch?v={video_id}",
            )
        )
    if not vods:
        raise BrollError("Manifest contains no videos.")
    return vods


def parse_timecode(value: Any, label: str) -> int:
    """Parse seconds, mm:ss, or hh:mm:ss into a whole second."""

    if isinstance(value, bool):
        raise BrollError(f"{label} must be a timecode, not a boolean.")
    if isinstance(value, (int, float)):
        numeric = float(value)
        if not math.isfinite(numeric):
            raise BrollError(f"{label} is outside the supported range.")
        seconds = int(numeric)
        if seconds < 0 or seconds > MAX_TIMESTAMP_SECONDS:
            raise BrollError(f"{label} is outside the supported range.")
        return seconds
    if not isinstance(value, str) or not value.strip():
        raise BrollError(f"{label} is required.")

    text = value.strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        seconds = int(float(text))
    else:
        parts = text.split(":")
        if len(parts) not in (2, 3) or not all(re.fullmatch(r"\d+(?:\.\d+)?", p) for p in parts):
            raise BrollError(f"{label} has invalid timecode {value!r}.")
        if not all(re.fullmatch(r"\d+", p) for p in parts[:-1]):
            raise BrollError(f"{label} has invalid timecode {value!r}.")
        values = [float(part) for part in parts]
        last = values[-1]
        minutes = values[-2]
        hours = values[0] if len(values) == 3 else 0.0
        if last >= 60 or minutes >= 60:
            raise BrollError(f"{label} has invalid timecode {value!r}.")
        seconds = int(hours * 3600 + minutes * 60 + last)
    if seconds < 0 or seconds > MAX_TIMESTAMP_SECONDS:
        raise BrollError(f"{label} is outside the supported range.")
    return seconds


def _unique_clip_id(base: str, used: set[str]) -> str:
    candidate = base[:64]
    suffix = 2
    while candidate in used:
        tail = f"-{suffix}"
        candidate = f"{base[: 64 - len(tail)]}{tail}"
        suffix += 1
    return candidate


def build_clip_library(vods: Iterable[Vod]) -> dict[str, Any]:
    """Flatten nested review clips into the exact Stream Dock import schema."""

    result: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for vod in vods:
        for clip_index, raw in enumerate(vod.clips, start=1):
            if raw.get("include", True) is False:
                continue
            context = f"{vod.video_id} clip {clip_index}"
            start_raw = raw.get("startSeconds", raw.get("start"))
            start = parse_timecode(start_raw, f"{context} start")
            if "endSeconds" in raw or "end" in raw:
                end_raw = raw.get("endSeconds", raw.get("end"))
                end = parse_timecode(end_raw, f"{context} end")
            elif "durationSeconds" in raw or "duration" in raw:
                duration_raw = raw.get("durationSeconds", raw.get("duration"))
                duration = parse_timecode(duration_raw, f"{context} duration")
                end = start + duration
            else:
                raise BrollError(f"{context} needs end/endSeconds or duration/durationSeconds.")
            if end <= start or end > MAX_TIMESTAMP_SECONDS:
                raise BrollError(f"{context} must end after its start and before 24:00:00.")

            requested_id = str(raw.get("id") or "").strip()
            if requested_id:
                if not CLIP_ID_RE.fullmatch(requested_id):
                    raise BrollError(f"{context} has invalid clip ID {requested_id!r}.")
                base_id = requested_id
            else:
                base_id = f"{vod.video_id}-{start}-{end}"
            clip_id = _unique_clip_id(base_id, used_ids)
            used_ids.add(clip_id)

            default_title = f"{vod.title or 'Highlight'} @ {format_timecode(start)}"
            title = str(raw.get("title") or default_title).strip()[:MAX_TITLE_LENGTH]
            result.append(
                {
                    "id": clip_id,
                    "title": title,
                    "videoId": vod.video_id,
                    "startSeconds": start,
                    "endSeconds": end,
                }
            )
            if len(result) > MAX_CLIPS:
                raise BrollError(f"A Stream Dock library can contain at most {MAX_CLIPS} clips.")
    return {"version": 1, "clips": result}


def format_timecode(seconds: int | float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def resolve_yt_dlp() -> Path:
    candidates = [
        REPO_ROOT / ".venv" / "Scripts" / "yt-dlp.exe",
        REPO_ROOT / ".venv" / "bin" / "yt-dlp",
    ]
    return _first_executable(candidates, "workspace .venv yt-dlp")


def resolve_ffmpeg() -> Path:
    candidates: list[Path] = []
    candidates.extend(
        sorted(
            (REPO_ROOT / ".venv" / "Lib" / "site-packages" / "imageio_ffmpeg" / "binaries").glob(
                "ffmpeg-*.exe"
            )
        )
    )
    candidates.extend(
        sorted(
            (REPO_ROOT / ".venv" / "lib").glob(
                "python*/site-packages/imageio_ffmpeg/binaries/ffmpeg-*"
            )
        )
    )
    return _first_executable(candidates, "bundled imageio-ffmpeg")


def _first_executable(candidates: Iterable[Path], description: str) -> Path:
    for candidate in candidates:
        if candidate.is_file() and (os.name == "nt" or os.access(candidate, os.X_OK)):
            return candidate.resolve()
    raise BrollError(
        f"Could not find {description}. Expected it beneath {REPO_ROOT / '.venv'}."
    )


def _command_text(command: Sequence[str | Path]) -> str:
    values = [str(value) for value in command]
    return subprocess.list2cmdline(values) if os.name == "nt" else shlex.join(values)


def _run(command: Sequence[str | Path], dry_run: bool) -> None:
    print(f"$ {_command_text(command)}")
    if not dry_run:
        subprocess.run([str(value) for value in command], check=True)


def _find_proxy(proxy_dir: Path, video_id: str) -> Path | None:
    preferred = proxy_dir / f"{video_id}.mp4"
    if preferred.is_file():
        return preferred
    for path in sorted(proxy_dir.glob(f"{video_id}.*")):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
            return path
    return None


def _read_info(proxy_dir: Path, video_id: str) -> dict[str, Any]:
    path = proxy_dir / f"{video_id}.info.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _load_existing_review(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if not path.is_file():
        return {}, {}
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as exc:
        raise BrollError(
            f"Cannot safely update existing review manifest {path}: {exc}"
        ) from exc
    if not isinstance(document, dict) or not isinstance(document.get("videos"), list):
        raise BrollError(f"Existing review manifest has an unsupported shape: {path}")
    by_id = {
        str(item.get("videoId")): item
        for item in document["videos"]
        if isinstance(item, dict) and item.get("videoId")
    }
    return by_id, document


def _relative(path: Path, parent: Path) -> str:
    try:
        return path.relative_to(parent).as_posix()
    except ValueError:
        return str(path)


def _sheet_metadata(
    paths: list[Path],
    review_dir: Path,
    duration: int | None,
    interval: int,
    cells: int,
) -> list[dict[str, Any]]:
    sheets: list[dict[str, Any]] = []
    for page_index, path in enumerate(paths):
        first = page_index * cells * interval
        samples = [first + index * interval for index in range(cells)]
        if duration is not None:
            samples = [sample for sample in samples if sample <= duration]
        entry: dict[str, Any] = {
            "path": _relative(path, review_dir),
            "samples": samples,
        }
        if samples:
            entry["range"] = f"{format_timecode(samples[0])}-{format_timecode(samples[-1])}"
        sheets.append(entry)
    return sheets


def _download_command(
    yt_dlp: Path,
    vod: Vod,
    proxy_dir: Path,
    height: int,
    max_filesize: str,
    cookies_from_browser: str | None,
    force: bool,
) -> list[str | Path]:
    command: list[str | Path] = [
        yt_dlp,
        "--no-playlist",
        "--newline",
        "--write-info-json",
        "--format",
        f"best[height<={height}]/worst[height<={height}]/worst",
        "--remux-video",
        "mp4",
        "--max-filesize",
        max_filesize,
        "--output",
        proxy_dir / "%(id)s.%(ext)s",
    ]
    command.append("--force-overwrites" if force else "--no-overwrites")
    if cookies_from_browser:
        command.extend(["--cookies-from-browser", cookies_from_browser])
    command.append(vod.source_url)
    return command


def _sheet_command(
    ffmpeg: Path,
    proxy: Path,
    output_pattern: Path,
    interval: int,
    width: int,
    columns: int,
    rows: int,
) -> list[str | Path]:
    # Pages are row-major. Each cell is sampled at a stable wall-clock interval.
    filters = (
        f"fps=1/{interval},"
        f"scale={width}:-2:flags=lanczos,"
        f"tile={columns}x{rows}:nb_frames={columns * rows}:padding=6:margin=8:color=0x08111f"
    )
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        proxy,
        "-an",
        "-vf",
        filters,
        "-fps_mode",
        "vfr",
        "-q:v",
        "3",
        "-start_number",
        "1",
        output_pattern,
    ]


def _write_json(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def prepare(args: argparse.Namespace) -> int:
    vods = load_manifest(args.manifest.resolve())
    review_dir = args.review_dir.resolve()
    proxy_dir = review_dir / "proxies"
    sheet_dir = review_dir / "sheets"
    review_path = review_dir / "review.json"
    existing_by_id, existing_document = _load_existing_review(review_path)
    yt_dlp = resolve_yt_dlp()
    ffmpeg = resolve_ffmpeg()

    settings_changed = bool(existing_document) and any(
        existing_document.get(key) != value
        for key, value in (
            ("sampleEverySeconds", args.sheet_interval),
            ("sheetColumns", args.columns),
            ("sheetRows", args.rows),
            ("sheetCellWidth", args.sheet_width),
        )
    )
    if not args.dry_run:
        proxy_dir.mkdir(parents=True, exist_ok=True)
        sheet_dir.mkdir(parents=True, exist_ok=True)

    review_videos: list[dict[str, Any]] = []
    for index, vod in enumerate(vods, start=1):
        print(f"\n[{index}/{len(vods)}] {vod.video_id} {vod.title}".rstrip())
        proxy = _find_proxy(proxy_dir, vod.video_id)
        if proxy is None or args.force:
            _run(
                _download_command(
                    yt_dlp,
                    vod,
                    proxy_dir,
                    args.proxy_height,
                    args.max_filesize,
                    args.cookies_from_browser,
                    args.force,
                ),
                args.dry_run,
            )
            proxy = proxy_dir / f"{vod.video_id}.mp4" if args.dry_run else _find_proxy(proxy_dir, vod.video_id)
            if proxy is None:
                raise BrollError(f"yt-dlp completed but no proxy was found for {vod.video_id}.")
        else:
            print(f"  cached proxy: {_relative(proxy, review_dir)}")

        sheet_paths = sorted(sheet_dir.glob(f"{vod.video_id}-sheet-*.jpg"))
        regenerate = args.force or settings_changed or not sheet_paths
        if regenerate:
            if not args.dry_run:
                for old_sheet in sheet_paths:
                    old_sheet.unlink()
            output_pattern = sheet_dir / f"{vod.video_id}-sheet-%03d.jpg"
            _run(
                _sheet_command(
                    ffmpeg,
                    proxy,
                    output_pattern,
                    args.sheet_interval,
                    args.sheet_width,
                    args.columns,
                    args.rows,
                ),
                args.dry_run,
            )
            sheet_paths = [] if args.dry_run else sorted(sheet_dir.glob(f"{vod.video_id}-sheet-*.jpg"))
            if not args.dry_run and not sheet_paths:
                raise BrollError(f"ffmpeg completed but made no contact sheets for {vod.video_id}.")
        else:
            print(f"  cached sheets: {len(sheet_paths)}")

        info = _read_info(proxy_dir, vod.video_id)
        old = existing_by_id.get(vod.video_id, {})
        duration_value = info.get("duration", old.get("durationSeconds"))
        try:
            duration = max(0, int(float(duration_value))) if duration_value is not None else None
        except (TypeError, ValueError):
            duration = None
        old_clips = old.get("clips", [])
        if not isinstance(old_clips, list):
            raise BrollError(
                f"Existing review clips for {vod.video_id} must be an array; fix {review_path}."
            )
        clips = vod.clips if vod.clips else list(old_clips)
        title = vod.title or str(old.get("title") or info.get("title") or vod.video_id)
        entry: dict[str, Any] = {
            "videoId": vod.video_id,
            "title": title,
            "sourceUrl": vod.source_url,
            "durationSeconds": duration,
            "proxy": _relative(proxy, review_dir),
            "contactSheets": _sheet_metadata(
                sheet_paths,
                review_dir,
                duration,
                args.sheet_interval,
                args.columns * args.rows,
            ),
            "notes": str(old.get("notes") or ""),
            "clips": clips,
        }
        review_videos.append(entry)

    review = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sampleEverySeconds": args.sheet_interval,
        "sheetColumns": args.columns,
        "sheetRows": args.rows,
        "sheetCellWidth": args.sheet_width,
        "frameOrder": "row-major",
        "videos": review_videos,
    }
    if args.dry_run:
        print(f"\nDry run: would write {review_path}")
    else:
        _write_json(review_path, review)
        print(f"\nReview manifest: {review_path}")
        print("Add clip ranges there, then run the emit command shown in the README.")
    return 0


def emit(args: argparse.Namespace) -> int:
    library = build_clip_library(load_manifest(args.manifest.resolve()))
    output = args.output.resolve()
    if args.dry_run:
        print(json.dumps(library, indent=2, ensure_ascii=False))
        print(f"Dry run: would write {output}", file=sys.stderr)
    else:
        _write_json(output, library)
        print(f"Wrote {len(library['clips'])} clips to {output}")
    return 0


def list_vods(args: argparse.Namespace) -> int:
    vods = load_manifest(args.manifest.resolve())
    review_dir = args.review_dir.resolve()
    rows: list[dict[str, Any]] = []
    for vod in vods:
        proxy = _find_proxy(review_dir / "proxies", vod.video_id)
        sheets = sorted((review_dir / "sheets").glob(f"{vod.video_id}-sheet-*.jpg"))
        rows.append(
            {
                "videoId": vod.video_id,
                "title": vod.title,
                "proxy": str(proxy) if proxy else None,
                "contactSheetCount": len(sheets),
                "includedClipCount": sum(clip.get("include", True) is not False for clip in vod.clips),
            }
        )
    if args.json:
        print(json.dumps({"videos": rows}, indent=2, ensure_ascii=False))
        return 0

    print(f"{'VIDEO ID':11}  {'PROXY':5}  {'SHEETS':6}  {'CLIPS':5}  TITLE")
    for row in rows:
        title = str(row["title"] or "")
        print(
            f"{row['videoId']:11}  "
            f"{('yes' if row['proxy'] else 'no'):5}  "
            f"{row['contactSheetCount']:6}  "
            f"{row['includedClipCount']:5}  "
            f"{title[:60]}"
        )
    return 0


def bounded_int(minimum: int, maximum: int):
    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("must be an integer") from exc
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(f"must be between {minimum} and {maximum}")
        return number

    return parse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare YouTube VOD review proxies/contact sheets and emit Stream Dock b-roll JSON."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare", help="download cached proxies and build contact sheets")
    prepare_parser.add_argument("manifest", type=Path)
    prepare_parser.add_argument("--review-dir", type=Path, default=DEFAULT_REVIEW_DIR)
    prepare_parser.add_argument("--proxy-height", type=bounded_int(144, 720), default=360)
    prepare_parser.add_argument("--max-filesize", default="1G", help="yt-dlp safety cap (default: 1G)")
    prepare_parser.add_argument("--sheet-interval", type=bounded_int(10, 3600), default=180)
    prepare_parser.add_argument("--sheet-width", type=bounded_int(160, 960), default=320)
    prepare_parser.add_argument("--columns", type=bounded_int(1, 8), default=4)
    prepare_parser.add_argument("--rows", type=bounded_int(1, 8), default=3)
    prepare_parser.add_argument(
        "--cookies-from-browser",
        metavar="BROWSER",
        help="pass a signed-in browser profile name to yt-dlp, for example chrome or edge",
    )
    prepare_parser.add_argument("--force", action="store_true", help="re-download and rebuild derived assets")
    prepare_parser.add_argument("--dry-run", action="store_true", help="print commands without writing or downloading")
    prepare_parser.set_defaults(handler=prepare)

    emit_parser = subparsers.add_parser("emit", help="validate/flatten review clips for Stream Dock import")
    emit_parser.add_argument("manifest", type=Path, help="usually REVIEW_DIR/review.json")
    emit_parser.add_argument("--output", "-o", type=Path, default=DEFAULT_REVIEW_DIR / "broll-library.json")
    emit_parser.add_argument("--dry-run", action="store_true", help="validate and print JSON without writing")
    emit_parser.set_defaults(handler=emit)

    list_parser = subparsers.add_parser("list", help="show manifest IDs and cached review status")
    list_parser.add_argument("manifest", type=Path)
    list_parser.add_argument("--review-dir", type=Path, default=DEFAULT_REVIEW_DIR)
    list_parser.add_argument("--json", action="store_true", help="print machine-readable status")
    list_parser.set_defaults(handler=list_vods)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except BrollError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"error: media command exited with status {exc.returncode}", file=sys.stderr)
        return int(exc.returncode or 1)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
