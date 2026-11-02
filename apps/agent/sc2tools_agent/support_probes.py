"""Read-only bounded diagnostic adapters. Never repair runtime services."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlsplit, urlunsplit

import requests
from urllib3.exceptions import TimeoutError as RawTimeoutError

from .support_diagnostics import DiagnosticRow, active, count, latency

HTTP_BODY_MAX = 64 * 1024
FOLDER_MAX = 16
FOLDER_ENTRY_MAX = 5000
FOLDER_DEPTH_MAX = 6


class FolderRoots:
    """Private bounded discovery input; never part of a support result."""
    __slots__ = ("paths", "complete", "automatic_available")

    def __init__(self, paths, complete=True, automatic_available=True):
        self.paths, self.complete, self.automatic_available = tuple(paths), complete, automatic_available


@dataclass(frozen=True, slots=True)
class FolderSummary:
    index: int
    replay_count: int | None
    newest_utc: str | None
    complete: bool
    readable: bool

    def __post_init__(self):
        if (type(self.index) is not int or not 1 <= self.index <= FOLDER_MAX
            or self.replay_count is not None and count(self.replay_count) is None
            or type(self.complete) is not bool or type(self.readable) is not bool
            or self.newest_utc is not None and (type(self.newest_utc) is not str
                or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", self.newest_utc) is None)):
            raise ValueError("invalid_folder_summary")


@dataclass(frozen=True, slots=True)
class ProbeResult:
    row: DiagnosticRow
    folders: tuple[FolderSummary, ...] = ()


def probe_base(value):
    """Stricter than ordinary API configuration: no ambient URL credentials."""
    if type(value) is not str or not 1 <= len(value) <= 2048 or not value.isascii():
        return None
    if any(ord(char) <= 32 or ord(char) == 127 for char in value):
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            return None
        parsed.port
        return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    except ValueError:
        return None


def _row(name, status="unavailable", code="unavailable", action="retry", **facts):
    return ProbeResult(DiagnosticRow(name, status, code, action, **facts))


def http_probe(name, base, *, token=None, version=None, channel="stable", is_current,
               is_cancelled, deadline, session_factory=requests.Session, clock=time.monotonic):
    """One isolated session, exact endpoint, no redirects/netrc/proxy/cookies.

    Reject content encodings and read raw body bytes without decompression.
    Check deadlines between returned bytes. OS/DNS/header/chunk-framing calls
    cannot be instantly cancelled and remain admitted until actual settlement.
    """
    paths = {"version": "/v1/agent/version", "api": "/v1/health", "profile": "/v1/me/profile", "client_api": "/ui"}
    target = probe_base(base)
    if name not in paths or target is None:
        return _row(name if name in paths else "api", code="invalid_response", action="open_settings")
    if name == "profile" and (type(token) is not str or not 0 < len(token) <= 4096):
        return _row(name, code="signed_out", action="link_again")
    if name == "version" and (type(channel) is not str or channel not in ("stable", "beta", "dev")
        or type(version) is not str or re.fullmatch(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", version) is None):
        return _row(name, code="invalid_response")
    if not active(is_current, is_cancelled):
        return _row(name, code="cancelled")
    started, response, session = clock(), None, None
    try:
        remaining = deadline - clock()
        if remaining <= 0:
            return _row(name, "warn", "timeout")
        session = session_factory()
        session.trust_env = False
        session.auth = None
        session.cookies.clear()
        session.headers.clear()
        session.proxies.clear()
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        if name == "profile":
            headers["Authorization"] = "Bearer " + token
        params = {"current": version, "channel": channel, "platform": "windows"} if name == "version" else None
        if not active(is_current, is_cancelled):
            return _row(name, code="cancelled")
        response = session.get(target + paths[name], headers=headers, params=params, auth=None,
            cookies={}, proxies={}, allow_redirects=False, stream=True,
            timeout=(min(2.0, remaining), min(2.0, remaining)))
        if not active(is_current, is_cancelled):
            return _row(name, code="cancelled")
        if clock() >= deadline:
            return _row(name, "warn", "timeout")
        status = response.status_code
        if name == "profile" and status in (401, 403):
            return _row(name, "fail", "signed_out", "link_again")
        if status != 200:
            return _row(name, "warn", "not_running" if name == "client_api" else "invalid_response")
        encoding = response.headers.get("Content-Encoding", "identity")
        if type(encoding) is not str or encoding.strip().lower() not in ("", "identity"):
            return _row(name, "warn", "invalid_response")
        if name != "profile":
            data = bytearray()
            while True:
                if not active(is_current, is_cancelled):
                    return _row(name, code="cancelled")
                if clock() >= deadline:
                    return _row(name, "warn", "timeout")
                chunk = response.raw.read(1, decode_content=False)
                if not active(is_current, is_cancelled):
                    return _row(name, code="cancelled")
                if clock() >= deadline:
                    return _row(name, "warn", "timeout")
                if type(chunk) is not bytes or len(data) + len(chunk) > HTTP_BODY_MAX:
                    return _row(name, "warn", "invalid_response")
                if not chunk:
                    break
                data.extend(chunk)
            payload = json.loads(bytes(data).decode("utf-8", errors="strict"))
            if type(payload) is not dict:
                return _row(name, "warn", "invalid_response")
            if name == "version":
                latest = payload.get("latest")
                published = type(latest) is str and re.fullmatch(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", latest) is not None
                empty_channel = ("latest" not in payload and payload.get("ok") is True
                    and payload.get("update_available") is False and payload.get("channel") == channel
                    and payload.get("platform") == "windows")
                if not published and not empty_channel:
                    return _row(name, "warn", "invalid_response")
        if not active(is_current, is_cancelled):
            return _row(name, code="cancelled")
        return _row(name, "pass", "ok", latency_ms=latency((clock() - started) * 1000))
    except (requests.Timeout, RawTimeoutError):
        return _row(name, "warn", "timeout") if active(is_current, is_cancelled) else _row(name, code="cancelled")
    except requests.ConnectionError:
        return _row(name, "warn", "not_running" if name == "client_api" else "offline") if active(is_current, is_cancelled) else _row(name, code="cancelled")
    except Exception:
        return _row(name, "warn", "invalid_response") if active(is_current, is_cancelled) else _row(name, code="cancelled")
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        if session is not None:
            try:
                session.close()
            except Exception:
                pass


def _folder_files():
    from .support_files_windows import WindowsFiles
    return WindowsFiles()


def folders_probe(roots, *, is_current, is_cancelled, deadline, clock=time.monotonic,
                  roots_complete=True, automatic_available=True):
    if not active(is_current, is_cancelled):
        return _row("folders", code="cancelled")
    if not roots:
        return ProbeResult(DiagnosticRow("folders", count=0 if automatic_available else None))
    try:
        files = _folder_files()
    except (OSError, ValueError):
        return _row("folders")  # No path-based fallback without pinned ancestors.
    summaries, inspected_total, timed_out = [], 0, False
    for index, root in enumerate(tuple(roots[:FOLDER_MAX])):
        if not active(is_current, is_cancelled):
            return _row("folders", code="cancelled")
        if clock() >= deadline:
            return ProbeResult(DiagnosticRow("folders", "warn", "timeout", "retry", count(sum(item.readable for item in summaries))), tuple(summaries))
        seen, newest, complete, readable = 0, None, True, False
        try:
            # Keep the selected root pinned throughout its recursive walk.
            with files.hold_directory(root) as held_root:
                pending = [(held_root, 0)]
                while pending:
                    if not active(is_current, is_cancelled):
                        return _row("folders", code="cancelled")
                    if clock() >= deadline or inspected_total >= FOLDER_ENTRY_MAX:
                        complete, timed_out = False, clock() >= deadline
                        break
                    directory, depth = pending.pop()
                    try:
                        # Each descendant and every ancestor stays pinned during
                        # both enumeration and all DirEntry metadata operations.
                        with files.hold_directory(directory) as held_directory:
                            if not active(is_current, is_cancelled):
                                return _row("folders", code="cancelled")
                            with os.scandir(held_directory) as entries:
                                readable = readable or depth == 0
                                for entry in entries:
                                    if not active(is_current, is_cancelled):
                                        return _row("folders", code="cancelled")
                                    if inspected_total >= FOLDER_ENTRY_MAX or clock() >= deadline:
                                        complete, timed_out = False, clock() >= deadline
                                        break
                                    inspected_total += 1
                                    try:
                                        info = entry.stat(follow_symlinks=False)
                                    except OSError:
                                        complete = False
                                        continue
                                    if not active(is_current, is_cancelled):
                                        return _row("folders", code="cancelled")
                                    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                                        complete = False
                                        continue
                                    if stat.S_ISDIR(info.st_mode):
                                        if depth >= FOLDER_DEPTH_MAX:
                                            complete = False
                                        else:
                                            pending.append((Path(entry.path), depth + 1))
                                    elif stat.S_ISREG(info.st_mode) and entry.name.lower().endswith(".sc2replay"):
                                        seen += 1
                                        newest = info.st_mtime if newest is None else max(newest, info.st_mtime)
                    except (OSError, ValueError):
                        complete = False
                        if depth == 0:
                            readable = False
        except (OSError, ValueError):
            readable, complete = False, False
        if not active(is_current, is_cancelled):
            return _row("folders", code="cancelled")
        timestamp = None
        if newest is not None:
            try:
                timestamp = datetime.fromtimestamp(newest, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            except (OverflowError, OSError, ValueError):
                complete = False
        summaries.append(FolderSummary(index + 1, seen if readable else None, timestamp, complete, readable))
    all_readable = bool(summaries) and all(item.readable for item in summaries)
    complete = roots_complete and len(roots) <= FOLDER_MAX and all(item.complete for item in summaries)
    status = "unavailable" if not automatic_available else "pass" if all_readable and complete else "warn" if summaries else "unavailable"
    row = DiagnosticRow("folders", status, "unavailable" if not automatic_available else "ok" if status == "pass" else "timeout" if timed_out else "missing_folders" if summaries else "unavailable",
        "retry" if not automatic_available else "open_settings", count(sum(item.readable for item in summaries)))
    return ProbeResult(row, tuple(summaries))


def obs_probe(enabled, connection, *, is_current, is_cancelled, deadline,
              client_factory=None, clock=time.monotonic):
    if enabled is not True:
        return _row("obs", code="disabled", action="none")
    if not active(is_current, is_cancelled):
        return _row("obs", code="cancelled")
    started, client = clock(), None
    try:
        if deadline <= clock():
            return _row("obs", "warn", "timeout")
        if client_factory is None:
            from obsws_python import ReqClient
            client_factory = ReqClient
        host, port, password = connection
        client = client_factory(host=host, port=port, password=password, timeout=min(2.0, deadline - clock()))
        if not active(is_current, is_cancelled):
            return _row("obs", code="cancelled")
        client.get_version()
        if not active(is_current, is_cancelled):
            return _row("obs", code="cancelled")
        if clock() >= deadline:
            return _row("obs", "warn", "timeout")
        return _row("obs", "pass", "ok", latency_ms=latency((clock() - started) * 1000))
    except Exception:
        return _row("obs", "warn", "unavailable", "open_settings") if active(is_current, is_cancelled) else _row("obs", code="cancelled")
    finally:
        if client is not None:
            try:
                client.disconnect()
            except Exception:
                pass


def sync_probe(facts, pending):
    if facts is None or pending is None:
        return _row("sync")
    code = facts.error_kind if facts.error_kind in ("signed_out", "offline", "server_busy", "rate_limited", "file", "rejected") else "ok"
    return _row("sync", "warn" if code != "ok" or facts.paused else "pass", code,
        "link_again" if code == "signed_out" else "open_settings" if facts.paused else "retry", count=count(pending))
