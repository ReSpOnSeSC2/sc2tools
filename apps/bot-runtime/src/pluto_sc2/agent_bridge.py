"""Fixed JSON bridge for an explicitly enabled local SC2TOOLS Bot Lab.

Imported only by its configured external Python interpreter. It lists committed
legacy league checkpoints; it does not expose unverified AlphaStar candidates.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

from pluto_sc2.play_lobby import PlayLobby, RACES


def public_session(raw):
    names = {"session_id": "id", "status": "status", "human_race": "humanRace", "bot_race": "botRace",
             "bot_label": "botLabel", "map": "map", "result": "result"}
    result = {target: raw[name] for name, target in names.items()
              if name in raw and isinstance(raw[name], (str, int, bool, type(None)))}
    if raw.get("error"):
        result["error"] = "The local match could not continue. Check the agent on this PC."
    if result.get("status") == "running":
        result["status"] = "playing"
    return result


def sc2_active():
    import psutil
    try:
        for process in psutil.process_iter(["name"]):
            if re.fullmatch(r"sc2(?:_x64)?(?:\.exe)?", (process.info.get("name") or "").lower()):
                return True
    except psutil.Error:
        return True
    return False


def handle(request, *, lobby_factory=PlayLobby, active_check=sc2_active):
    if not isinstance(request, dict) or set(request) - {"operation", "workspace", "sessionId", "botId", "mapId", "humanRace"}:
        return {"ok": False, "code": "invalid_request", "message": "Invalid Bot Lab request."}
    workspace = Path(request.get("workspace", ""))
    if not workspace.is_absolute() or not workspace.is_dir():
        return {"ok": False, "code": "setup_required", "message": "Configure the local bot workspace in the agent."}
    lobby = lobby_factory(workspace)
    operation = request.get("operation")
    try:
        if operation == "catalog":
            options = lobby.options()
            bots = [{"id": row["id"], "label": row["label"], "race": row["race"], "updates": row["updates"],
                     "maxApm": row["max_apm"], "cameraRestricted": row["camera_restricted"]} for row in options["bots"]]
            ready = bool(bots and options["maps"])
            return {"ok": True, "ready": ready, "code": "ready" if ready else "models_unavailable",
                    "message": "Local committed practice bots." if ready else "No committed bot and map are available.",
                    "bots": bots, "maps": options["maps"], "activeSessionId": options["active_session_id"], "startWorkers": 8}
        session_id = request.get("sessionId")
        if not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9]{32}", session_id):
            return {"ok": False, "code": "invalid_request", "message": "Invalid local session identity."}
        if operation == "status":
            return {"ok": True, "session": public_session(lobby.status(session_id))}
        if operation == "stop":
            lobby.close({"id": session_id, "close": True})
            return {"ok": True, "session": public_session(lobby.status(session_id))}
        if operation != "start" or request.get("humanRace") not in RACES:
            return {"ok": False, "code": "invalid_request", "message": "Choose a supported operation and race."}
        # Idempotent internal identity: an existing reservation can only be read.
        if (lobby.root / session_id).exists():
            return {"ok": True, "session": public_session(lobby.status(session_id))}
        stops = [workspace / "STOP", lobby.root / "STOP", workspace / "runs/response-league/STOP",
                 workspace / "runs/response-league-monitor/STOP"]
        if any(path.exists() for path in stops):
            return {"ok": False, "code": "stop_marker", "message": "Local game launches are stopped on this PC."}
        if active_check():
            return {"ok": False, "code": "sc2_busy", "message": "Close the active StarCraft II session before starting a bot game."}
        launched = lobby.launch({"human_race": request["humanRace"], "bot_id": request.get("botId"),
                                 "map_id": request.get("mapId")}, session_id=session_id)
        return {"ok": True, "session": public_session(launched)}
    except ValueError:
        return {"ok": False, "code": "session_unavailable" if operation in ("status", "stop") else "selection_unavailable",
                "message": "That local session or selection is unavailable. Refresh the bot list."}
    except Exception:
        return {"ok": False, "code": "local_error", "message": "The local bot runtime could not complete this request."}


def main():
    # The match subprocess uses this same fixed shipped package, rather than
    # relying on the external interpreter having an editable project install.
    os.environ["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    try:
        encoded = sys.stdin.buffer.read(32769)
        if len(encoded) > 32768:
            raise ValueError("request too large")
        result = handle(json.loads(encoded))
    except Exception:
        result = {"ok": False, "code": "invalid_request", "message": "Invalid local bot request."}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
