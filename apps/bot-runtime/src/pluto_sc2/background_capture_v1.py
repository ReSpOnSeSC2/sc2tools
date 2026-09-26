"""Opt-in actor capture adapter; frozen collectors and live defaults stay unchanged.

No module import launches anything. Native compatibility and installed mapper
coordination must be independently established before binding the collector.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import math
import os
from pathlib import Path
import threading
import time

import psutil

from .isolated_capture_process_v1 import launch_isolated_capture

CONTRACT = "non-input-desktop-player-capture-v1"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_identity(identity):
    process = psutil.Process(identity["pid"])
    if abs(process.create_time() - identity["process_created_at"]) > .01:
        raise RuntimeError("Agent PID creation identity changed")
    if Path(process.exe()).resolve() != Path(identity["executable"]).resolve():
        raise RuntimeError("Agent executable changed")
    return process


def validate_coordination_proof(proof, agent, lock_path):
    """Source-tree code is insufficient evidence about a running packaged EXE."""
    if (proof.get("schema") != "installed-agent-engine-lock-proof-v1" or proof.get("status") != "passed"
            or proof.get("installed_executable_sha256") != digest(agent["executable"])
            or proof.get("pid") != agent["pid"] or proof.get("process_created_at") != agent["process_created_at"]
            or proof.get("lock_path") != str(lock_path.resolve())
            or proof.get("lock_semantics") != "msvcrt-byte0-exclusive"
            or proof.get("all_native_capture_paths_guarded") is not True
            or proof.get("busy_lock_defers_capture_without_loss") is not True):
        raise RuntimeError("Installed mapper coordination is unverified; cannot claim source-tree lock")
    if not lock_path.is_file() or lock_path.is_symlink() or lock_path.stat().st_size < 1:
        raise RuntimeError("Installed mapper's existing engine lock is absent or invalid")


def validate_native_proof(proof, executable, data_version):
    if (proof.get("schema") != "isolated-desktop-native-player-proof-v1" or proof.get("status") != "passed"
            or proof.get("contract") != CONTRACT or proof.get("executable_sha256") != digest(executable)
            or proof.get("data_version") != data_version
            or proof.get("launcher_sha256") != digest(Path(__file__).with_name("isolated_capture_process_v1.py"))
            or proof.get("eight_starting_workers_verified") is not True
            or proof.get("player_perspective_fog_verified") is not True
            or proof.get("observation_and_step_verified") is not True
            or proof.get("non_input_desktop_verified") is not True
            or proof.get("visible_fallback_used") is not False
            or proof.get("owned_process_cleanup_verified") is not True):
        raise RuntimeError("Native SC2 isolated-desktop compatibility remains unverified")


class EngineLease:
    """Claim the mapper's existing byte lock; never fabricate its ownership path.

    The running installation must prove its capture requests defer while busy.
    This is stronger than merely observing an engine-free gap or upload counts.
    """
    def __init__(self, *, agent, state_dir, coordination_proof, stop_paths=(), deadline):
        self.agent, self.proof = agent, coordination_proof
        self.lock_path = Path(state_dir).resolve() / "engine-activity.lock"
        self.stops, self.deadline = tuple(map(Path, stop_paths)), deadline
        self.stream = None

    def check(self):
        if not math.isfinite(self.deadline) or time.monotonic() >= self.deadline:
            raise TimeoutError("Capture wall deadline reached")
        if any(path.exists() for path in self.stops):
            raise InterruptedError("STOP marker respected")
        require_identity(self.agent)
        if self.stream is None:
            raise RuntimeError("Capture does not own the mapper engine lease")
        opened, named = os.fstat(self.stream.fileno()), self.lock_path.stat()
        if opened.st_ino != named.st_ino or opened.st_dev != named.st_dev:
            raise RuntimeError("Engine lock path changed while held")

    def __enter__(self):
        import msvcrt
        require_identity(self.agent)
        validate_coordination_proof(self.proof, self.agent, self.lock_path)
        # Existing-only: no mkdir, lock-file creation, pause, or agent mutation.
        stream = self.lock_path.open("r+b")
        try:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except BaseException:
            stream.close()
            raise
        self.stream = stream
        try:
            self.check()
            if any((p.info.get("name") or "").lower() == "sc2_x64.exe"
                   for p in psutil.process_iter(["name"])):
                raise RuntimeError("SC2 is active despite acquired lease; ownership unproved")
            # Recheck the actual installed process and proof under the lease.
            validate_coordination_proof(self.proof, self.agent, self.lock_path)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *_):
        import msvcrt
        stream, self.stream = self.stream, None
        if stream is not None:
            try:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                stream.close()


def process_class(lease, diagnostics, native_proof):
    from sc2.paths import Paths, latest_executeble
    from .runner import ManagedSC2Process

    class IsolatedSC2Process(ManagedSC2Process):
        def _launch(self):
            lease.check()
            if self._sc2_version or not self._base_build or not self._data_hash or self._render:
                raise RuntimeError("Exact replay build/data and non-RGB interface required")
            executable = latest_executeble(Paths.BASE / "Versions", self._base_build)
            validate_native_proof(native_proof, executable, self._data_hash)
            if self._host != "127.0.0.1" or self._serverhost != "127.0.0.1" or not 1 <= self._port <= 65535:
                raise RuntimeError("Only a local pinned API endpoint is supported")
            self._capture_log = (Path(diagnostics) / "isolated-engine.log").open("xb")
            args = [str(executable), "-listen", "127.0.0.1", "-port", str(self._port),
                    "-dataDir", str(Paths.BASE), "-tempDir", self._tmp_dir,
                    "-dataVersion", self._data_hash, "-displayMode", "0",
                    "-windowwidth", "640", "-windowheight", "480"]
            child = None
            try:
                child = launch_isolated_capture(args, cwd=str(Paths.CWD), stdout=self._capture_log)
                self.background_identity = {"pid": child.pid, "process_created_at": child.process_created_at,
                    "desktop_name": child.desktop_name, "contract": CONTRACT}
                self._background_stop = threading.Event()

                def monitor():
                    while not self._background_stop.wait(.1):
                        try:
                            lease.check()
                            child.check_background()
                            if self._capture_log.tell() > 8 * 1024 * 1024:
                                raise RuntimeError("Native diagnostic log exceeded 8MiB budget")
                            if child.poll() is not None:
                                return
                        except BaseException as error:
                            self.background_error = f"{type(error).__name__}: {error}"
                            child.terminate()
                            return

                self._background_monitor = threading.Thread(target=monitor, name="isolated-capture-proof", daemon=True)
                self._background_monitor.start()
                return child
            except BaseException:
                if child is not None:
                    child.close()
                self._capture_log.close()
                raise

        async def _connect(self):
            lease.check()
            self._process.check_background()
            return await super()._connect()

        def _clean(self, verbose=False):
            # The stock implementation requires subprocess.Popen and can kill
            # by global switches. This path owns only retained job/child handles.
            if getattr(self, "_background_stop", None) is not None:
                self._background_stop.set()
                self._background_monitor.join(timeout=2)
            child = self._process
            if child is not None:
                child.close()
                self._process = None
            if getattr(self, "_capture_log", None) is not None:
                self._capture_log.close()
            # Temporary artifacts are retained for diagnosis, never recursively
            # deleted. Return only this instance's dynamically allocated port.
            if self._used_portpicker and self._port is not None and self._port != -1:
                import portpicker
                portpicker.return_port(self._port)
                self._port = -1
            self._ws = None

    return IsolatedSC2Process


@contextmanager
def bind_background_collector(lease, diagnostics, native_proof):
    """Use only in a dedicated sequential capture Python process.

    Frozen capture_replay imports ManagedSC2Process locally. This binding is
    restored even after failure, with no file changes or default behavior change.
    """
    from . import runner
    lease.check()
    if (threading.current_thread() is not threading.main_thread() or threading.active_count() != 1
            or runner.ManagedSC2Process._active):
        raise RuntimeError("Background collector requires an idle dedicated main thread")
    original = runner.ManagedSC2Process
    replacement = process_class(lease, diagnostics, native_proof)
    runner.ManagedSC2Process = replacement
    try:
        yield replacement
    finally:
        runner.ManagedSC2Process = original
