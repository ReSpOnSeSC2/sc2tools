"""Launch an isolated replay spectator, with an optional native SC2 launcher."""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

import mpyq
import psutil


MAX_REPLAY_BYTES = 256 * 1024 * 1024


def validate_replay(path: Path) -> dict:
    """Reject missing, partial, or changing replay files without starting SC2."""
    path = Path(path).expanduser().resolve()
    if path.suffix.lower() != ".sc2replay" or not path.is_file():
        raise ValueError("Choose an existing .SC2Replay file.")
    if path.anchor.startswith("\\\\"):
        raise ValueError("Copy the replay to a local drive before watching it.")
    before = path.stat()
    if not 0 < before.st_size <= MAX_REPLAY_BYTES:
        raise ValueError("The replay is empty or exceeds the 256 MiB viewing limit.")
    try:
        contents = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("The replay is still being written; wait for it to finish.")
        if len(contents) != before.st_size or not contents.startswith((b"MPQ\x1a", b"MPQ\x1b")):
            raise ValueError("The replay archive is incomplete or invalid.")
        archive = mpyq.MPQArchive(BytesIO(contents))
        for member in ("replay.details", "replay.initData", "replay.game.events"):
            # Reading each essential member also verifies its compressed data.
            if archive.read_file(member) is None:
                raise ValueError(f"The replay archive is missing {member}.")
        raw = archive.read_file("replay.gamemetadata.json")
        metadata = json.loads(raw.decode("utf-8")) if raw else None
        if not isinstance(metadata, dict) or not metadata.get("Players") or not metadata.get("BaseBuild"):
            raise ValueError("The replay is missing the game metadata needed for viewing.")
    except (OSError, ValueError) as error:
        raise ValueError(f"Replay is not ready to watch: {error}") from error
    except Exception as error:
        raise ValueError("Replay is not ready to watch: its archive could not be read.") from error
    return {"replay": str(path), "sha256": hashlib.sha256(contents).hexdigest(),
            "base_build": metadata["BaseBuild"], "game_version": metadata.get("GameVersion"),
            "map_name": metadata.get("MapName")}


def _find_switcher(sc2_path: Path | None) -> Path:
    # Support/SC2Switcher.exe is the official .SC2Replay association installed
    # on this computer. Support64 is a supported installation-layout fallback.
    root = Path(sc2_path or os.environ.get("SC2PATH") or
                "C:/Program Files (x86)/StarCraft II").expanduser().resolve()
    for relative in ("Support/SC2Switcher.exe", "Support64/SC2Switcher_x64.exe"):
        candidate = root / relative
        if candidate.is_file():
            return candidate
    raise ValueError(f"StarCraft II's replay launcher was not found in {root}. Set SC2PATH to its installation folder.")


def launch_native_replay(path: Path, sc2_path: Path | None = None) -> dict:
    """Request normal Windows SC2 playback; return the launcher's process info.

    A successful return means the official launcher was started. Playback can
    still need a missing game version or map, or prompt in the SC2 window. The
    viewer uses additional local CPU/GPU resources while training continues.
    """
    if sys.platform != "win32":
        raise ValueError("The interactive replay launcher currently supports Windows only.")
    replay = validate_replay(path)
    switcher = _find_switcher(sc2_path)
    try:
        child = subprocess.Popen([str(switcher), replay["replay"]], cwd=str(switcher.parent),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, shell=False, close_fds=True)
    except OSError as error:
        raise RuntimeError(f"Could not start the StarCraft II replay viewer: {error}") from error
    try:
        created_at = psutil.Process(child.pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        created_at = None  # SC2Switcher can immediately hand off and exit.
    return {**replay, "status": "launch_requested", "launcher": str(switcher),
            "launcher_pid": child.pid, "launcher_created_at": created_at}


def launch_replay(path: Path, sc2_path: Path | None = None, output_root: Path | None = None) -> dict:
    """Start a separate, hidden helper that owns a visible SC2 replay window."""
    if sys.platform != "win32":
        raise ValueError("The interactive replay launcher currently supports Windows only.")
    replay = validate_replay(path)
    output = (Path(output_root) if output_root else Path.cwd() / "runs/replay-browser/viewers").resolve()
    output = output / uuid.uuid4().hex
    output.mkdir(parents=True, exist_ok=False)
    from pluto_sc2.replay_viewer import write_json
    write_json(output / "control.json", {"paused": False, "speed": 1.0, "close": False})
    write_json(output / "status.json", {**replay, "status": "starting", "viewer_id": output.name,
        "viewer_output": str(output), "game_seconds": 0, "speed": 1.0, "error": None})
    executable = Path(sys.executable)
    pythonw = executable.with_name("pythonw.exe")
    if pythonw.is_file():
        executable = pythonw
    command = [str(executable), "-m", "pluto_sc2.replay_viewer", "--replay", replay["replay"], "--output", str(output)]
    if sc2_path:
        command += ["--sc2-path", str(Path(sc2_path).resolve())]
    try:
        with (output / "viewer.log").open("a", encoding="utf-8") as log:
            child = subprocess.Popen(command, cwd=str(Path.cwd()), stdin=subprocess.DEVNULL,
                stdout=log, stderr=log, shell=False, close_fds=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError as error:
        write_json(output / "status.json", {"status": "failed", "error": str(error), "viewer_id": output.name})
        raise RuntimeError(f"Could not start the StarCraft II replay viewer: {error}") from error
    try:
        created_at = psutil.Process(child.pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        created_at = None
    write_json(output / "launch.json", {"pid": child.pid, "process_created_at": created_at})
    return {**replay, "status": "launch_requested", "viewer_id": output.name, "viewer_output": str(output),
            "launcher_pid": child.pid, "launcher_created_at": created_at}
