"""Replay folder labels without Qt or network dependencies."""
from dataclasses import dataclass
import os
from pathlib import Path
import re
import time

from .regions import region_from_toon_handle

TOON = re.compile(r"^\d+-S2-\d+-\d+$", re.I)


@dataclass(frozen=True)
class FolderInfo:
    path: Path
    region: str | None
    toon: str | None
    replay_count: int
    newest_mtime: float | None
    exists: bool


def folder_identity(path):
    toon = next((part for part in reversed(Path(path).parts) if TOON.match(part)), None)
    return region_from_toon_handle(toon), toon


def describe_folder(path):
    path = Path(path)
    region, toon = folder_identity(path)
    count, newest = 0, None
    exists = path.is_dir()
    if exists:
        for directory, _folders, files in os.walk(path):
            for name in files:
                if not name.lower().endswith(".sc2replay"):
                    continue
                count += 1
                try:
                    mtime = (Path(directory) / name).stat().st_mtime
                    newest = mtime if newest is None else max(newest, mtime)
                except OSError:
                    pass
    return FolderInfo(path, region, toon, count, newest, exists)


def folder_label(info, *, now=None):
    if not info.exists:
        return "Not found (external drive?)"
    pieces = [info.region or "?", info.toon or info.path.name, f"{info.replay_count:,} replay" + ("s" if info.replay_count != 1 else "")]
    if info.newest_mtime is not None:
        seconds = max(0, (time.time() if now is None else now) - info.newest_mtime)
        age = f"{int(seconds // 86400)} d" if seconds >= 86400 else f"{int(seconds // 3600)} h" if seconds >= 3600 else f"{int(seconds // 60)} min"
        pieces.append(f"newest {age} ago")
    return " · ".join(pieces)
