"""Opt-in local Bot Lab controller; the ordinary agent imports no ML runtime."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

_LOCK = threading.RLock()
TERMINAL = {"finished", "closed", "failed"}
START_REFUSALS = {"invalid_request", "setup_required", "stop_marker", "sc2_busy", "selection_unavailable"}
MAX_OUTPUT = 131072


@contextmanager
def _thread_guard(timeout):
    if not _LOCK.acquire(timeout=timeout):
        raise TimeoutError("The local game engine is busy")
    try:
        yield
    finally:
        _LOCK.release()


def _read(path, default=None):
    if not path.exists():
        return {} if default is None else default
    with path.open(encoding="utf-8") as stream:
        result = json.load(stream)
    if not isinstance(result, dict):
        raise ValueError("Invalid local Bot Lab state")
    return result


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + ".pending")
    with pending.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    pending.replace(path)


@contextmanager
def engine_activity_guard(state_dir, timeout=3):
    """Shared with replay capture; OS lock releases automatically after a crash."""
    if state_dir is None:
        raise RuntimeError("A local state directory is required for engine coordination")
    path = Path(state_dir) / "engine-activity.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with _thread_guard(timeout), path.open("a+b") as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b"0")
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("The local game engine is busy") from None
                time.sleep(.05)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def bot_match_blocks_capture(state_dir, *, invoke=None):
    """Under engine_activity_guard, reconcile an existing match before capture.

    Ordinary capture never invokes the bot runtime. A previously reserved match
    may finish after its browser tab closes, so its own status is checked lazily
    before deciding whether the durable engine reservation still blocks capture.
    """
    if state_dir is None:
        return True
    try:
        path = Path(state_dir) / "bot-lab-journal.json"
        journal = _read(path)
        session_id = journal.get("activeSessionId")
        if not session_id:
            return False
        if (journal.get("schema") != 1 or not isinstance(journal.get("requests"), dict)
                or not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9]{32}", session_id)):
            return True
        records = [row for row in journal["requests"].values() if row.get("sessionId") == session_id]
        if not records:
            return True
        result = (invoke or _invoke)(_read(Path(state_dir) / "bot-lab.json"),
                                     {"operation": "status", "sessionId": session_id})
        session = result.get("session", {})
        terminal = (result.get("ok") is True and session.get("id") == session_id
                    and session.get("status") in TERMINAL)
        if terminal or result.get("code") == "session_unavailable":
            for row in records:
                row["state"] = "terminal"
            journal["activeSessionId"] = None
            _write(path, journal)
            return False
        return True
    except Exception:
        return True


def _failure(code, message, request_id=None, *, status="failed"):
    result = {"ok": False, "ready": False, "status": status, "code": code, "message": message, "error": message}
    if request_id is not None:
        result["requestId"] = request_id
    return result


def _runtime_source():
    bundled = getattr(sys, "_MEIPASS", None)
    root = Path(bundled) / "bot-runtime/src" if bundled else Path(__file__).resolve().parents[2] / "bot-runtime/src"
    if not (root / "pluto_sc2/agent_bridge.py").is_file():
        raise ValueError("The shipped bot runtime is unavailable")
    return root


def _invoke(config, payload):
    executable, workspace = Path(config["python"]), Path(config["workspace"])
    if not executable.is_absolute() or not executable.is_file() or not workspace.is_absolute() or not workspace.is_dir():
        raise ValueError("Configure an existing absolute Python executable and bot workspace")
    source = _runtime_source()
    bootstrap = "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_module('pluto_sc2.agent_bridge',run_name='__main__')"
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    process = subprocess.Popen([str(executable), "-I", "-c", bootstrap, str(source)],
        cwd=str(workspace), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        shell=False, close_fds=True, env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    chunks, oversized = [], threading.Event()

    def drain():
        total = 0
        while True:
            chunk = process.stdout.read(8192)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_OUTPUT:
                oversized.set()
                process.kill()
                break
            chunks.append(chunk)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        process.stdin.write(json.dumps({**payload, "workspace": str(workspace)}).encode())
        process.stdin.close()
        process.wait(timeout=30)
    except BaseException:
        process.kill()
        process.wait(timeout=3)
        raise
    finally:
        reader.join(timeout=3)
    if oversized.is_set() or reader.is_alive() or process.returncode:
        raise ValueError("Local bot runtime failed or exceeded its output limit")
    result = json.loads(b"".join(chunks))
    if not isinstance(result, dict):
        raise ValueError("Invalid local bot response")
    return result


def _public(result):
    """Defense in depth: never return process metadata, local paths, or traces."""
    allowed = {key: result[key] for key in ("ok", "ready", "code", "message", "activeSessionId", "startWorkers") if key in result}
    if "bots" in result:
        allowed["bots"] = [{key: row[key] for key in ("id", "label", "race", "updates", "maxApm", "cameraRestricted") if key in row}
                           for row in result["bots"][:256]]
    if "maps" in result:
        allowed["maps"] = [{key: row[key] for key in ("id", "label") if key in row} for row in result["maps"][:128]]
    if isinstance(result.get("session"), dict):
        allowed["session"] = {key: result["session"][key] for key in
            ("id", "status", "sessionId", "humanRace", "botRace", "botLabel", "map", "result", "error") if key in result["session"]}
    return allowed


class BotLabController:
    def __init__(self, state_dir, state=None, *, invoke=_invoke):
        self.state_dir, self.state, self.invoke = Path(state_dir), state, invoke
        self.config_path = self.state_dir / "bot-lab.json"
        self.journal_path = self.state_dir / "bot-lab-journal.json"

    def handle(self, request):
        request_id = request.get("requestId") if isinstance(request, dict) else None
        operation = request.get("operation") if isinstance(request, dict) else None
        if (not isinstance(request, dict) or (operation != "catalog" and
                (not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id)))):
            return _failure("invalid_request", "A valid request identity is required.")
        keys = ({"operation"} if operation == "catalog" else {"operation", "requestId"}) | (
            {"botId", "mapId", "humanRace"} if operation == "start" else set())
        if operation not in {"catalog", "start", "status", "stop"} or set(request) != keys:
            return _failure("invalid_request", "Invalid Bot Lab request.", request_id)
        if operation == "start" and (request["humanRace"] not in ("Protoss", "Terran", "Zerg")
                or any(not isinstance(request[key], str) or not re.fullmatch(r"[a-f0-9]{24}", request[key]) for key in ("botId", "mapId"))):
            return _failure("invalid_request", "Choose a race, committed bot, and map.", request_id)
        try:
            with engine_activity_guard(self.state_dir):
                config = _read(self.config_path)
                if config.get("enabled") is not True and operation not in ("status", "stop"):
                    return _failure("disabled", "Enable Bot Lab locally in the agent before starting games.", request_id)
                if (self.state_dir / "STOP").exists() and operation not in ("status", "stop"):
                    return _failure("stop_marker", "Local engine operations are stopped on this PC.", request_id)
                journal = _read(self.journal_path, {"schema": 1, "requests": {}, "activeSessionId": None})
                if journal.get("schema") != 1 or not isinstance(journal.get("requests"), dict):
                    raise ValueError("Invalid request journal")
                records = journal["requests"]
                payload = {key: value for key, value in request.items() if key != "requestId"}
                if operation == "start":
                    signature = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
                    existing = records.get(request_id)
                    if existing:
                        if existing["signature"] != signature:
                            return _failure("request_conflict", "This request identity was used for another selection.", request_id)
                        session_id = existing["sessionId"]
                        # Reservation is durable BEFORE launch. Ambiguous retries
                        # may reconcile, but can never execute start a second time.
                        payload = {"operation": "status", "sessionId": session_id}
                    else:
                        disk_state = _read(self.state_dir / "agent.json")
                        if disk_state.get("replay_capture_enabled") is True or getattr(self.state, "replay_capture_enabled", False) is True:
                            return _failure("replay_capture_enabled", "Turn off automatic replay capture before starting a bot game.", request_id)
                        if journal.get("activeSessionId"):
                            return _failure("match_active", "A bot match is already reserved or active. Check its status first.", request_id)
                        if len(records) >= 10000:
                            return _failure("journal_full", "The local game history requires maintenance.", request_id)
                        session_id = hashlib.sha256(("sc2tools-bot-lab:" + request_id).encode()).hexdigest()[:32]
                        records[request_id] = {"signature": signature, "sessionId": session_id, "state": "reserved"}
                        journal["activeSessionId"] = session_id
                        _write(self.journal_path, journal)
                        payload["sessionId"] = session_id
                elif operation in ("status", "stop"):
                    existing = records.get(request_id)
                    if not existing:
                        result = _failure("session_unavailable", "This agent has not recorded that launch request.", request_id)
                        if operation == "status":
                            # Status may overtake a delayed first start request.
                            # Absence of a journal entry cannot prove rejection.
                            result["status"] = "unknown"
                        return result
                    payload["sessionId"] = existing["sessionId"]
                result = _public(self.invoke(config, payload))
                session = result.get("session", {})
                session_id = payload.get("sessionId")
                terminal = session.get("status") in TERMINAL or result.get("code") == "session_unavailable"
                if session_id and (terminal or (payload["operation"] == "start" and result.get("code") in START_REFUSALS)):
                    if journal.get("activeSessionId") == session_id:
                        journal["activeSessionId"] = None
                    for row in records.values():
                        if row.get("sessionId") == session_id:
                            row["state"] = "terminal"
                    _write(self.journal_path, journal)
                if operation == "catalog":
                    result["activeSessionId"] = next((key for key, row in records.items()
                        if row.get("sessionId") == journal.get("activeSessionId")), None)
                    disk_state = _read(self.state_dir / "agent.json")
                    if disk_state.get("replay_capture_enabled") is True or getattr(self.state, "replay_capture_enabled", False) is True:
                        result.update(ready=False, code="replay_capture_enabled",
                                      message="Turn off automatic replay capture before starting a bot game.")
                    return result
                session_result = result.pop("session", {})
                if session_result:
                    result.update(session_result)
                    result["sessionId"] = session_result.get("id", payload.get("sessionId"))
                else:
                    definite = result.get("code") in START_REFUSALS | {"session_unavailable"}
                    result.update(status="failed" if definite else "unknown",
                                  error=result.get("message", "Local session unavailable."))
                return {**result, "id": request_id, "requestId": request_id}
        except TimeoutError:
            return _failure("engine_busy", "The local engine is busy recording a replay or starting a game.", request_id,
                            status="failed" if operation == "catalog" else "unknown")
        except Exception:
            return _failure("local_error", "Check the local Bot Lab configuration or reconcile the reserved session status.", request_id,
                            status="failed" if operation == "catalog" else "unknown")
