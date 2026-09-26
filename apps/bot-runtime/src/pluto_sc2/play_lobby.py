"""Local human-match choices and isolated launches from committed checkpoints."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import uuid

from filelock import FileLock
import psutil

from pluto_sc2.replay_browser import alive, read_json
from pluto_sc2.replay_viewer import write_json

RACES = ("Protoss", "Terran", "Zerg")
TERMINAL = ("finished", "closed", "failed")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class PlayLobby:
    def __init__(self, workspace):
        self.workspace = Path(workspace).resolve()
        self.root = self.workspace / "runs/human-matches"

    def inside(self, path):
        path = (self.workspace / path).resolve()
        if not path.is_relative_to(self.workspace):
            raise ValueError("Play files must stay inside this workspace")
        return path

    def choices(self):
        active = read_json(self.workspace / "TRAINING_ACTIVE.json")
        league = self.inside(active.get("league", "runs/response-league"))
        monitor = self.inside(active.get("supervisor", "runs/response-league-monitor"))
        manifest = read_json(league / "state.json")
        maximum = manifest.get("adversary_max_apm", 600)
        if type(maximum) is not int or not 1 <= maximum <= 600:
            raise ValueError("The league has an invalid opponent APM limit")
        bots, paths = [], {}
        for race in RACES:
            entries = manifest.get("snapshots", {}).get(race, [])
            for index, entry in reversed(list(enumerate(entries))):
                if not isinstance(entry, dict):
                    continue
                path = self.inside(league / entry.get("path", ""))
                checksum = entry.get("sha256", "")
                updates = entry.get("updates")
                if (not path.is_file() or not path.is_relative_to(league)
                        or not re.fullmatch(r"[a-f0-9]{64}", str(checksum))
                        or type(updates) is not int or updates < 0):
                    continue
                identifier = hashlib.sha256(f"{race}:{path}:{checksum}".encode()).hexdigest()[:24]
                latest = index == len(entries) - 1
                label = f"{'Latest · ' if latest else ''}{race} · {updates} updates"
                bots.append(dict(id=identifier, race=race, label=label, updates=updates,
                                 latest=latest, max_apm=200 if race == "Protoss" else maximum,
                                 camera_restricted=race == "Protoss"))
                paths[identifier] = (path, checksum)
        maps, map_paths = [], {}
        for name in read_json(monitor / "config.json").get("maps", []):
            path = self.inside(name)
            if path.suffix.lower() != ".sc2map" or not path.is_file():
                continue
            identifier = hashlib.sha256(str(path).encode()).hexdigest()[:24]
            if identifier in map_paths:
                continue
            maps.append(dict(id=identifier, label=path.stem))
            map_paths[identifier] = path
        return bots, paths, maps, map_paths

    def options(self):
        bots, _, maps, _ = self.choices()
        return dict(bots=bots, maps=maps, defaults=dict(human_race="Protoss",
                    bot_id=bots[0]["id"] if bots else None,
                    map_id=maps[0]["id"] if maps else None),
                    active_session_id=self.active_session(), start_workers=8)

    def folder(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Choose a match started by this local play panel")
        folder = self.inside(self.root / identifier)
        if not folder.is_dir():
            raise ValueError("That local match does not exist")
        return folder

    def status(self, identifier):
        folder = self.folder(identifier)
        receipt = read_json(folder / "launch.json")
        status = {**read_json(folder / "selection.json"), **read_json(folder / "status.json")}
        status.setdefault("status", "starting")
        owner = status if status.get("pid") else receipt
        if status["status"] not in TERMINAL and not alive(owner):
            if not owner.get("pid") and (folder / "launch-intent.json").exists():
                # A crashed bridge may have spawned the match before recording
                # its identity. Keep that reservation until the match writes
                # its own status; absence of a receipt is not proof of exit.
                status.update(status="unknown", error="The reserved match needs local reconciliation.")
                return {**status, "session_id": identifier}
            # Allow the tiny interval between creating the folder and Popen's receipt.
            if owner.get("pid") or time.time() - folder.stat().st_ctime > 15:
                status.update(status="failed", error="The match process exited. Start a new match to retry.")
        return {**status, "session_id": identifier}

    def active_session(self):
        for folder in sorted(self.root.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if folder.is_dir() and re.fullmatch(r"[a-f0-9]{32}", folder.name):
                if self.status(folder.name)["status"] not in TERMINAL:
                    return folder.name
        return None

    def close(self, request):
        if set(request) != {"id", "close"} or request.get("close") is not True:
            raise ValueError("Only ending this local match is supported")
        folder = self.folder(request["id"])
        write_json(folder / "control.json", {"close": True})
        return {"ok": True, "session_id": folder.name, "close": True}

    def launch(self, request, *, session_id=None):
        if set(request) != {"human_race", "bot_id", "map_id"}:
            raise ValueError("Choose your race, a bot checkpoint, and a map")
        if request["human_race"] not in RACES:
            raise ValueError("Your race must be Protoss, Terran, or Zerg")
        if session_id is not None and (not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9]{32}", session_id)):
            raise ValueError("Internal session identity must be 32 lowercase hexadecimal characters")
        self.root.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.root / ".launch.lock"), timeout=5):
            if session_id is not None and (self.root / session_id).exists():
                # A durable reservation is never reused, even if launch crashed
                # before its process receipt. Reconcile rather than duplicate.
                return {**self.status(session_id), "ok": True}
            if self.active_session():
                raise ValueError("A match is already open. Finish it or select End match first.")
            bots, paths, maps, map_paths = self.choices()
            bot = next((row for row in bots if row["id"] == request["bot_id"]), None)
            selected_map = next((row for row in maps if row["id"] == request["map_id"]), None)
            if bot is None or selected_map is None:
                raise ValueError("That bot or map is unavailable. Refresh the bot list and select again.")
            source, checksum = paths[bot["id"]]
            if digest(source) != checksum:
                raise ValueError("The committed bot checkpoint changed; refusing to launch it")
            output = self.root / (session_id or uuid.uuid4().hex)
            output.mkdir()
            child = None
            try:
                # Copy, then independently check the copy. Training may append snapshots,
                # but the policy used in this human match is fixed for its entire lifetime.
                checkpoint = output / "checkpoint.pt"
                checkpoint.write_bytes(source.read_bytes())
                if digest(checkpoint) != checksum:
                    raise ValueError("Checkpoint changed while preparing this match")
                selection = dict(session_id=output.name, human_race=request["human_race"],
                                 bot_race=bot["race"], bot_label=bot["label"], updates=bot["updates"],
                                 bot_id=bot["id"], map_id=selected_map["id"],
                                 map=selected_map["label"], source_checkpoint=str(source),
                                 checkpoint_sha256=checksum, start_workers=8, max_apm=bot["max_apm"],
                                 camera_restricted=bot["camera_restricted"], seed=secrets.randbelow(2**31))
                write_json(output / "selection.json", selection)
                write_json(output / "control.json", {"close": False})
                write_json(output / "status.json", {**selection, "status": "starting"})
                executable = Path(sys.executable)
                pythonw = executable.with_name("pythonw.exe")
                if sys.platform == "win32" and pythonw.is_file():
                    executable = pythonw
                command = [str(executable), "-m", "pluto_sc2.human_match", "--checkpoint", str(checkpoint),
                           "--bot-race", bot["race"], "--human-race", request["human_race"],
                           "--map", str(map_paths[selected_map["id"]]), "--output", str(output),
                           "--max-apm", str(bot["max_apm"] if bot["race"] != "Protoss" else 600),
                           "--seed", str(selection["seed"])]
                with (output / "match.log").open("a", encoding="utf-8") as log:
                    if session_id is not None:
                        write_json(output / "launch-intent.json", {"session_id": session_id})
                    child = subprocess.Popen(command, cwd=str(self.workspace), stdin=subprocess.DEVNULL,
                        stdout=log, stderr=log, shell=False, close_fds=True,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                try:
                    created_at = psutil.Process(child.pid).create_time()
                except psutil.Error:
                    created_at = None
                write_json(output / "launch.json", dict(pid=child.pid, process_created_at=created_at))
                return {**selection, "status": "starting", "ok": True}
            except Exception as error:
                # If spawn succeeded but its receipt could not be saved, the
                # match may still be live. Do not release its durable lease.
                write_json(output / "status.json", dict(status="unknown" if child is not None else "failed", error=str(error)))
                raise
