"""Local replay library. Reads training artifacts without controlling training."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import secrets
import shutil
import threading
import time
from urllib.parse import parse_qs, urlsplit
import webbrowser

import psutil


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def alive(record):
    try:
        process = psutil.Process(int(record["pid"]))
        return process.is_running() and abs(process.create_time() - float(record["process_created_at"])) < .01
    except (psutil.Error, KeyError, TypeError, ValueError):
        return False


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def display_map(value):
    value = str(value or "")
    return Path(value.replace("\\", "/")).stem if value.lower().endswith(".sc2map") else value


def coached_adjudication(session, receipt):
    """Read-only presentation of the explicit user-confirmed AI surrender.

    This never changes a replay, engine outcome, league record or PPO label.
    Free-form receipt text is evidence storage, not a display label or code.
    """
    game_id = session.get("game_id")
    duration, recorded_duration = session.get("game_seconds"), receipt.get("engine_game_seconds")
    evidence = receipt.get("evidence")
    if (session.get("profile") != "session-coached-protoss-v1"
            or type(session.get("schema")) is not int or session["schema"] != 1
            or session.get("learned_policy") is not False or session.get("status") != "complete"
            or not isinstance(game_id, str) or not re.fullmatch(r"[a-f0-9]{32}", game_id)
            or type(receipt.get("schema")) is not int or receipt["schema"] != 1
            or receipt.get("game_id") != game_id
            or session.get("result") != "Tie" or receipt.get("engine_result") != session.get("result")
            or receipt.get("result") != "Win" or receipt.get("basis") != "opponent_explicit_surrender"
            or receipt.get("adjudication") != "user_confirmed" or receipt.get("raw_session_preserved") is not True
            or not isinstance(evidence, dict) or not isinstance(evidence.get("user_confirmation"), str)
            or not evidence["user_confirmation"].strip()
            or any(type(value) not in (int, float) or not math.isfinite(value) or value < 0
                   for value in (duration, recorded_duration))
            or not math.isclose(duration, recorded_duration, rel_tol=0, abs_tol=1e-6)):
        return None
    return {"result": "Win", "result_label": "Win by AI surrender", "raw_engine_result": "Tie",
            "result_detail": "Raw engine result: Tie · user-confirmed surrender",
            "adjudication_basis": "opponent_explicit_surrender", "adjudication_source": "user_confirmed"}


class Catalogue:
    def __init__(self, workspace, inspector=None):
        self.workspace = Path(workspace).resolve()
        if inspector is None:
            from pluto_sc2.replays import inspect_replay
            inspector = inspect_replay
        self.inspector = inspector
        self.cache = {}
        self.paths = {}
        self.lock = threading.RLock()

    def inside(self, path):
        path = Path(path)
        resolved = (self.workspace / path).resolve() if not path.is_absolute() else path.resolve()
        if not resolved.is_relative_to(self.workspace):
            raise ValueError("Replay library paths must stay inside this workspace")
        return resolved

    def metadata(self, path):
        try:
            path = self.inside(path)
            stat = path.stat()
            key = (stat.st_size, stat.st_mtime_ns)
            cached = self.cache.get(path)
            if cached and cached[0] == key:
                return cached[1]
            info = self.inspector(path)
            # A concurrently written archive is not ready to launch yet.
            after = path.stat()
            if (after.st_size, after.st_mtime_ns) != key:
                return {}
            self.cache[path] = (key, info)
            return info
        except (OSError, ValueError):
            return {}

    def row(self, replay, *, source, number=None, record=None, pending=None, committed=False, running=False):
        replay = self.inside(replay)
        record, pending = record or {}, pending or {}
        info = self.metadata(replay) if replay.is_file() else {}
        players = sorted(info.get("players", []), key=lambda player: player.get("player_id", 0))
        learner = record.get("learner_race") or pending.get("learner_race") or (players[0]["race"] if players else "")
        opponent = record.get("opponent_race") or pending.get("opponent_race") or (players[1]["race"] if len(players) > 1 else "")
        result = next(iter(record.get("results") or []), "")
        if not result and players:
            result = {"Win": "Victory", "Loss": "Defeat"}.get(players[0].get("result"), players[0].get("result", ""))
        capped = record.get("time_limit_reached", False)
        if capped:
            result = "Time limit"
        elif result == "Unknown":
            result = "Unreported"
        stamp = replay.stat().st_mtime if replay.exists() else replay.parent.stat().st_mtime
        identifier = hashlib.sha256(str(replay.relative_to(self.workspace)).encode()).hexdigest()[:24]
        failure = read_json(replay.parent / "failure.json")
        status = ("Completed" if committed else "Replay ready") if info else ("In progress" if running else "Unavailable")
        if failure:
            status = "Failed attempt (replay available)" if info else "Failed attempt"
        elif record and not committed and source == "League":
            status = "Uncommitted attempt (replay available)" if info else "Uncommitted attempt"
        seconds = next(iter(record.get("game_seconds", [])), info.get("duration_seconds"))
        row = dict(id=identifier, title=f"Game {number}" if number else replay.parent.name,
                   number=number, matchup=f"{learner[:1]}v{opponent[:1]}" if learner and opponent else "",
                   learner=learner, opponent=opponent, result=result or "Pending", status=status,
                   ready=bool(info), committed=committed, game_seconds=seconds,
                   wall_seconds=record.get("wall_seconds"), map=display_map(info.get("map_name") or pending.get("map")),
                   started_at=pending.get("started_at"), ended_at=iso(stamp) if info else None,
                   replay_name=replay.name, source=source, sort_time=stamp,
                   opponent_profile=record.get("opponent_profile", ""))
        self.paths[identifier] = replay
        return row

    def snapshot(self):
        with self.lock:
            active = read_json(self.workspace / "TRAINING_ACTIVE.json")
            league = self.inside(active.get("league", "runs/response-league"))
            monitor = self.inside(active.get("supervisor", "runs/response-league-monitor"))
            state, progress = read_json(league / "state.json"), read_json(monitor / "state.json")
            live = alive(progress)
            stopping = (league / "STOP").exists() or (monitor / "STOP").exists()
            committed = set()
            for snapshots in state.get("snapshots", {}).values():
                for entry in snapshots:
                    committed.add(self.inside(league / entry["path"]).parent)
            rows = []
            self.paths = {}
            attempts = sorted((league / "matches").glob("[0-9]*-*"))
            latest = max(attempts, key=lambda p: p.stat().st_mtime, default=None)
            schedule = (("Protoss", "Terran"), ("Terran", "Protoss"), ("Protoss", "Protoss"),
                        ("Protoss", "Zerg"), ("Zerg", "Protoss"))
            maps = read_json(monitor / "config.json").get("maps", [])
            for attempt in attempts:
                if not attempt.is_dir():
                    continue
                try:
                    number = int(attempt.name.split("-", 1)[0])
                    pending = read_json(attempt / "viewer.json")
                    record = read_json(attempt / "match.json")
                    if pending:
                        running = alive(pending) and not record
                    else:
                        # Compatibility with jobs launched before the library was installed.
                        running = live and attempt == latest and number == state.get("games", 0) + 1 and not record
                        learner, opponent = schedule[(number - 1) % len(schedule)]
                        pending = dict(learner_race=learner, opponent_race=opponent,
                                       map=maps[(number - 1) % len(maps)] if maps else "",
                                       started_at=iso(attempt.stat().st_ctime))
                    rows.append(self.row(attempt / "game.SC2Replay", source="League", number=number,
                                         record=record, pending=pending, committed=attempt.resolve() in committed,
                                         running=running))
                except (OSError, ValueError):
                    continue  # A path may disappear or be replaced while the snapshot is read.
            # Include the current production opening curriculum and formal evaluations.
            roots = [(monitor / "evaluations", "Evaluation")]
            for race in ("terran", "zerg"):
                for split in ("train", "validation"):
                    roots.append((self.workspace / f"runs/response90-{race}-teachers" / split,
                                  f"{race.title()} opening / {split}"))
            for folder, source in roots:
                for replay in folder.rglob("*.SC2Replay"):
                    try:
                        record = {}
                        if source.endswith(("/ train", "/ validation")):
                            report = read_json(replay.parent / "report.json")
                            if report:
                                record = dict(results=[report.get("result", "Unreported")],
                                              game_seconds=[report.get("game_seconds")],
                                              time_limit_reached=report.get("game_seconds", 0) >= 359)
                        elif source == "Evaluation":
                            try:
                                index = int(replay.stem.removeprefix("eval-"))
                                lines = (replay.parent / "matches.jsonl").read_text(encoding="utf-8").splitlines()
                                record = json.loads(lines[index]) if index < len(lines) else {}
                            except (ValueError, OSError):
                                pass
                        rows.append(self.row(replay, source=source, record=record))
                    except (OSError, ValueError):
                        continue
            for folder in (self.workspace / "runs/human-matches").glob("*"):
                if not folder.is_dir() or not re.fullmatch(r"[a-f0-9]{32}", folder.name):
                    continue
                try:
                    selection = read_json(folder / "selection.json")
                    status = read_json(folder / "status.json")
                    record = read_json(folder / "match.json")
                    if not selection:
                        continue
                    human, bot = selection.get("human_race", ""), selection.get("bot_race", "")
                    pending = dict(learner_race=human, opponent_race=bot, map=selection.get("map"))
                    row = self.row(folder / "game.SC2Replay", source="Human match", record=record,
                                   pending=pending, committed=status.get("status") == "finished",
                                   running=alive(status) and status.get("status") in ("starting", "playing"))
                    row.update(title=f"Your game · {folder.name[:8]}", human_race=human, bot_race=bot)
                    if status.get("status") == "closed":
                        row["result"] = "Ended early"
                    elif status.get("status") == "failed":
                        row["status"] = "Failed match (replay available)" if row["ready"] else "Failed match"
                    rows.append(row)
                except (OSError, ValueError):
                    continue
            # Session-coached experiments are separate from league training.
            # Discover only immediate run folders with the exact known profile.
            for session_path in (self.workspace / "runs").glob("*/session.json"):
                try:
                    session_path = self.inside(session_path)
                    session = read_json(session_path)
                    game_id = session.get("game_id")
                    opponent = session.get("opponent_race")
                    if (session.get("profile") != "session-coached-protoss-v1"
                            or type(session.get("schema")) is not int or session["schema"] != 1
                            or session.get("learned_policy") is not False
                            or not isinstance(game_id, str) or not re.fullmatch(r"[a-f0-9]{32}", game_id)
                            or not isinstance(opponent, str) or opponent not in {"Protoss", "Terran", "Zerg"}):
                        continue
                    complete = session.get("status") == "complete"
                    raw_result = session.get("result") if complete else "Pending"
                    raw_result = (raw_result if isinstance(raw_result, str)
                                  and raw_result in {"Victory", "Defeat", "Tie", "Pending"} else "Unreported")
                    record = dict(results=[raw_result], learner_race="Protoss", opponent_race=session["opponent_race"],
                                  game_seconds=[session.get("game_seconds")], wall_seconds=session.get("wall_seconds"))
                    row = self.row(session_path.parent / "game.SC2Replay", source="Coached", record=record,
                                   pending={"map": session.get("map"), "started_at": session.get("created_at")},
                                   committed=complete, running=session.get("status") == "running" and alive(session))
                    row.update(game_id=game_id, learned_policy=False, raw_engine_result=raw_result)
                    if session.get("status") == "failed":
                        row["status"] = "Failed coached attempt (replay available)" if row["ready"] else "Failed coached attempt"
                    adjudication = coached_adjudication(session, read_json(self.inside(session_path.parent / "adjudication.json")))
                    if adjudication:
                        row.update(adjudication)
                    rows.append(row)
                except (OSError, ValueError):
                    continue
            rows.sort(key=lambda item: item["sort_time"], reverse=True)
            current = next((row["number"] for row in rows if row["source"] == "League"
                            and row["status"] == "In progress"), None)
            status = "Stopping after current game" if stopping and live else progress.get("status", "Not started")
            if status == "running" and not live:
                status = "Training process is not running"
            return dict(games=rows, training=dict(status=status, completed_games=state.get("games", 0),
                        current_game=current), generated_at=iso(time.time()))

    def replay(self, identifier):
        snapshot = self.snapshot()
        row = next((row for row in snapshot["games"] if row["id"] == identifier), None)
        if not row or not row["ready"]:
            raise ValueError("That replay is not available yet. Wait for the match to finish.")
        with self.lock:
            return self.inside(self.paths[identifier])


class ReplayServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, catalogue, port=0, launcher=None):
        from pluto_sc2.play_lobby import PlayLobby
        self.catalogue = catalogue
        self.play_lobby = PlayLobby(catalogue.workspace)
        self.token = secrets.token_urlsafe(32)
        self.launcher = launcher
        self.launch_lock = threading.Lock()
        self.last_launch = {}
        super().__init__(("127.0.0.1", port), Handler)
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.prefix = f"/{self.token}/"
        self.url = self.origin + self.prefix

    def viewer_folder(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Choose a replay viewer opened by this library")
        folder = self.catalogue.inside(self.catalogue.workspace / "runs/replay-browser/viewers" / identifier)
        if not folder.is_dir():
            raise ValueError("That replay viewer does not exist")
        return folder

    def viewer_status(self, identifier):
        folder = self.viewer_folder(identifier)
        status = read_json(folder / "status.json")
        receipt = read_json(folder / "launch.json")
        if not status:
            status = {"status": "starting"}
        owner = status if status.get("pid") else receipt
        if status.get("status") not in ("finished", "closed", "failed") and owner.get("pid") and not alive(owner):
            status = {**status, "status": "failed", "error": "The replay viewer exited. Open it again to retry."}
        return {**status, "viewer_id": identifier}

    def control_viewer(self, request):
        identifier = request.get("id")
        folder = self.viewer_folder(identifier)
        control = read_json(folder / "control.json") or {"paused": False, "speed": 1.0, "close": False}
        if set(request) - {"id", "paused", "speed", "close"}:
            raise ValueError("Unsupported viewer control")
        for key in ("paused", "close"):
            if key in request:
                if type(request[key]) is not bool:
                    raise ValueError(f"{key} must be true or false")
                control[key] = request[key]
        if "speed" in request:
            if type(request["speed"]) not in (int, float) or request["speed"] not in (.5, 1, 2, 4, 8):
                raise ValueError("Playback speed must be 0.5, 1, 2, 4 or 8")
            control["speed"] = request["speed"]
        # Concurrent requests serialize through launch_lock, so the temporary
        # control file cannot overwrite another pending command.
        temporary = folder / "control.json.tmp"
        temporary.write_text(json.dumps(control), encoding="utf-8")
        temporary.replace(folder / "control.json")
        return {"ok": True, **control}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        data = json.dumps(body, allow_nan=False).encode() if isinstance(body, dict) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        parsed = urlsplit(self.path)
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            return None, {}
        if not parsed.path.startswith(self.server.prefix):
            return None, {}
        return parsed.path[len(self.server.prefix):], parse_qs(parsed.query)

    def do_GET(self):
        route, query = self.route()
        try:
            if route == "":
                html = Path(__file__).with_name("replay_browser.html").read_text(encoding="utf-8")
                self.respond(200, html.replace("__REPLAY_TOKEN__", self.server.token).encode(), "text/html; charset=utf-8")
            elif route == "api/games":
                self.respond(200, self.server.catalogue.snapshot())
            elif route == "api/viewer":
                self.respond(200, self.server.viewer_status(query.get("id", [""])[0]))
            elif route == "api/play-options":
                self.respond(200, self.server.play_lobby.options())
            elif route == "api/play-status":
                self.respond(200, self.server.play_lobby.status(query.get("id", [""])[0]))
            elif route == "api/replay":
                path = self.server.catalogue.replay(query.get("id", [""])[0])
                with path.open("rb") as stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(path.stat().st_size))
                    self.send_header("Content-Disposition", f'attachment; filename="{path.parent.name}-{path.name}"')
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    shutil.copyfileobj(stream, self.wfile)
            else:
                self.respond(404, {"error": "Not found"})
        except (ValueError, OSError) as error:
            self.respond(400, {"error": str(error)})

    def do_POST(self):
        route, _ = self.route()
        if (route not in ("api/watch", "api/viewer-control", "api/play", "api/play-control")
                or self.headers.get("X-Replay-Token") != self.server.token
                or self.headers.get("Origin") not in (None, self.server.origin)
                or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")):
            self.respond(403, {"error": "Only this local page can launch or control a replay or match"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Invalid request size")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("Send a game selection object")
            if route in ("api/play", "api/play-control"):
                with self.server.launch_lock:
                    result = (self.server.play_lobby.launch(request) if route == "api/play"
                              else self.server.play_lobby.close(request))
                self.respond(200, result)
                return
            identifier = request.get("id") if isinstance(request, dict) else None
            if not isinstance(identifier, str):
                raise ValueError("Choose a game from the library")
            with self.server.launch_lock:
                if route == "api/viewer-control":
                    self.respond(200, self.server.control_viewer(request))
                    return
                path = self.server.catalogue.replay(identifier)
                now = time.monotonic()
                if now - self.server.last_launch.get(identifier, -100) < 3:
                    raise ValueError("This replay was just opened; give StarCraft II a moment to load")
                if self.server.launcher is None:
                    from pluto_sc2.replay_watch import launch_replay
                    viewer_root = self.server.catalogue.workspace / "runs/replay-browser/viewers"
                    for folder in viewer_root.glob("*"):
                        if not re.fullmatch(r"[a-f0-9]{32}", folder.name):
                            continue
                        existing = self.server.viewer_status(folder.name)
                        if existing.get("status") not in ("finished", "closed", "failed"):
                            raise ValueError("A replay viewer is already open. Close it with the playback controls first.")
                    result = launch_replay(path, output_root=viewer_root)
                else:
                    result = self.server.launcher(path)
                self.server.last_launch[identifier] = now
            self.respond(200, {"ok": True, "message": "Starting a dedicated replay viewer. Training continues.", **result})
        except (ValueError, OSError, RuntimeError) as error:
            self.respond(400, {"error": str(error)})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args(argv)
    from filelock import FileLock, Timeout
    workspace = args.workspace.resolve()
    output = workspace / "runs/replay-browser"
    output.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(output / "server.lock"), timeout=0)
    try:
        with lock:
            server = ReplayServer(Catalogue(workspace), args.port)
            process = psutil.Process()
            status = dict(url=server.url, pid=process.pid, process_created_at=process.create_time())
            temporary = output / "server.json.tmp"
            temporary.write_text(json.dumps(status), encoding="utf-8")
            temporary.replace(output / "server.json")
            if args.open_browser:
                webbrowser.open(server.url)
            try:
                server.serve_forever(poll_interval=.5)
            finally:
                server.server_close()
    except Timeout:
        status = read_json(output / "server.json")
        if alive(status) and args.open_browser:
            webbrowser.open(status["url"])
        elif not alive(status):
            raise RuntimeError("Replay browser is starting. Try opening it again shortly.")


if __name__ == "__main__":
    main()
