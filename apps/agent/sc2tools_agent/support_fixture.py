"""Fixed public replay check in a clean owned interpreter, never the agent."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from .support_diagnostics import active, latency

FIXTURE_BYTES = 63353
FIXTURE_SHA256 = "4bc930864e08f1bc5de1e5ce7e2af70d4bf49f8b2c3fe1f00fef26e4e8c8fc23"
LICENSE_SHA256 = "df45ac4f7de6a16f0f8c3d9a289cc6b2845445554e497126ba1be6bcb5b704b5"
FIXTURE_TOON = "5-S2-1-526043"
OUTPUT_MAX = 1024
CHILD_FLAG = "--support-fixture-check"


def resource_root():
    return Path(__file__).resolve().parent / "resources" / "support"


def resource_bytes(root=None):
    root = resource_root() if root is None else Path(root)
    expected = {"schema_version": 1, "filename": "diagnostic.SC2Replay", "bytes": FIXTURE_BYTES,
        "sha256": FIXTURE_SHA256, "player_toon": FIXTURE_TOON, "license_filename": "sc2reader-LICENSE.txt",
        "license_bytes": 1129, "license_sha256": LICENSE_SHA256, "upstream_repository": "ggtracker/sc2reader",
        "upstream_commit": "e10fc9344417d0aa9649e4ed8d6423e38f6af4c9",
        "upstream_path": "test_replays/5.0.15/96516_0.SC2Replay"}
    contents = {}
    for filename, limit in (("manifest.json", 4096), ("diagnostic.SC2Replay", FIXTURE_BYTES), ("sc2reader-LICENSE.txt", 1129)):
        with (root / filename).open("rb") as stream:
            contents[filename] = stream.read(limit + 1)
        if len(contents[filename]) > limit:
            raise ValueError("unavailable")
    manifest = json.loads(contents["manifest.json"].decode("utf-8", errors="strict"))
    replay = contents["diagnostic.SC2Replay"]
    notice = contents["sc2reader-LICENSE.txt"]
    if (manifest != expected or len(replay) != FIXTURE_BYTES or hashlib.sha256(replay).hexdigest() != FIXTURE_SHA256
        or len(notice) != 1129 or hashlib.sha256(notice).hexdigest() != LICENSE_SHA256):
        raise ValueError("unavailable")
    return replay


def child_environment(parent, temp_dir):
    # No PATH/PYTHONPATH/user profile, device/OBS/player/state/provider variables.
    names = ("SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PATHEXT")
    environment = {name: parent[name] for name in names if type(parent.get(name)) is str}
    environment.update(TEMP=str(temp_dir), TMP=str(temp_dir), TMPDIR=str(temp_dir),
        PYTHONIOENCODING="utf-8", PYTHONNOUSERSITE="1")
    return environment


def child_command():
    if getattr(sys, "frozen", False):
        return [sys.executable, CHILD_FLAG]
    return [sys.executable, "-I", str(Path(__file__).with_name("__main__.py")), CHILD_FLAG]


def _reap(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
    process.wait()  # Admission is retained until the owned process really exits.


def run_fixture(*, is_current, is_cancelled, deadline, process_factory=subprocess.Popen, clock=time.monotonic):
    if not active(is_current, is_cancelled):
        return {"status": "unavailable", "code": "cancelled"}
    if clock() >= deadline:
        return {"status": "warn", "code": "timeout"}
    started = clock()
    process, readers, output, overflow = None, [], {}, threading.Event()
    try:
        with tempfile.TemporaryDirectory(prefix="sc2tools-support-fixture-") as temp:
            environment = child_environment(os.environ, temp)
            if not active(is_current, is_cancelled):
                return {"status": "unavailable", "code": "cancelled"}
            try:
                process = process_factory(child_command(), cwd=temp, env=environment, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000 if os.name == "nt" else 0)

                def read(name, pipe):
                    try:
                        data = pipe.read(OUTPUT_MAX + 1)
                        if len(data) > OUTPUT_MAX:
                            overflow.set()
                        output[name] = data[:OUTPUT_MAX]
                    except Exception:
                        overflow.set()

                for name, pipe in (("stdout", process.stdout), ("stderr", process.stderr)):
                    reader = threading.Thread(target=read, args=(name, pipe), name="support-fixture-output", daemon=True)
                    reader.start()
                    readers.append(reader)
                code = None
                while process.poll() is None:
                    if not active(is_current, is_cancelled):
                        code = "cancelled"
                        break
                    if clock() >= deadline:
                        code = "timeout"
                        break
                    if overflow.is_set():
                        code = "invalid_response"
                        break
                    time.sleep(0.02)
            finally:
                if process is not None:
                    _reap(process)
                    for reader in readers:
                        reader.join()
                    process.stdout.close()
                    process.stderr.close()
            if not active(is_current, is_cancelled):
                return {"status": "unavailable", "code": "cancelled"}
            if code is not None:
                return {"status": "warn", "code": code}
            if clock() >= deadline:
                return {"status": "warn", "code": "timeout"}
            if overflow.is_set() or output.get("stderr") or process.returncode != 0:
                return {"status": "warn", "code": "analysis_failed"}
            response = json.loads(output.get("stdout", b"").decode("utf-8", errors="strict"))
            if (type(response) is not dict or set(response) != {"version", "ok", "code"}
                or type(response["version"]) is not int or response["version"] != 1 or type(response["ok"]) is not bool
                or response["code"] not in ("ok", "analysis_failed", "unavailable")
                or response["ok"] != (response["code"] == "ok")):
                return {"status": "warn", "code": "invalid_response"}
            return {"status": "pass" if response["ok"] else "warn", "code": response["code"],
                "latency_ms": latency((clock() - started) * 1000)}
    except Exception:
        return {"status": "unavailable", "code": "unavailable"}


class _Discard:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def _inherited_stdout(kernel):
    import ctypes
    from ctypes import wintypes
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    return kernel.GetStdHandle(wintypes.DWORD(0xFFFFFFF5))  # STD_OUTPUT_HANDLE=-11


def _write_windows_status(data):
    """A windowed frozen build may have no Python sys.stdout object.

    Popen supplies an inherited anonymous pipe through STARTUPINFO. Write only
    the bounded status bytes to that handle; never close a borrowed handle or
    fall back to a console, user file or normal agent startup.
    """
    if os.name != "nt" or type(data) is not bytes or not 0 < len(data) <= OUTPUT_MAX:
        return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = _inherited_stdout(kernel)
    if handle in (None, 0, ctypes.c_void_p(-1).value):
        return False
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    if kernel.GetFileType(handle) != 3:  # FILE_TYPE_PIPE; no console/disk fallback.
        return False
    kernel.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel.WriteFile.restype = wintypes.BOOL
    buffer, written = ctypes.create_string_buffer(data), wintypes.DWORD()
    return bool(kernel.WriteFile(handle, buffer, len(data), ctypes.byref(written), None)) and written.value == len(data)


def _emit_status(ok, code):
    data = (json.dumps({"version": 1, "ok": ok, "code": code}, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        if sys.stdout is not None:
            sys.stdout.write(data.decode("utf-8"))
            sys.stdout.flush()
            return 0
        return 0 if _write_windows_status(data) else 1
    except Exception:
        return 1


def fixture_main():
    """Dedicated isolated entry: emit one tiny status envelope, never payloads."""
    import contextlib
    import logging
    ok, code = False, "unavailable"
    # This function runs only in a fresh dedicated child, never a live worker.
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(_Discard()), contextlib.redirect_stderr(_Discard()):
        try:
            replay = resource_bytes()
            from .instant_analysis import RuntimeOptions, parse_replay_bytes
            from .replay_pipeline import probe_analyzer
            available, _discarded = probe_analyzer()
            if available:
                parsed = parse_replay_bytes(replay, filename="diagnostic.SC2Replay", runtime=RuntimeOptions(
                    player_toon=FIXTURE_TOON, threads=False, file_caches=False, network_lookups=False, engine_capture=False))
                ok = type(parsed) is dict and parsed.get("ok") is True
                code = "ok" if ok else "analysis_failed"
        except Exception:
            pass
    return _emit_status(ok, code)
