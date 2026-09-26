"""Strict launch and handoff tests with fake Win32/process APIs; never launch SC2."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import pytest

from pluto_sc2 import background_capture_v1 as capture
from pluto_sc2 import isolated_capture_process_v1 as native


class FakeAPI:
    def __init__(self, fail=None, active=False):
        self.fail, self.active = fail, active
        self.events, self.handles = [], 20
        self.kernel = self.user = self
        self.running = True

    def error(self, text):
        return OSError(text)

    def CreateDesktopW(self, name, *args):
        self.events.append(("desktop", name, args))
        return 0 if self.fail == "desktop" else 50

    def GetUserObjectInformationW(self, handle, key, output, size, needed):
        output._obj.value = self.active
        return self.fail != "desktop_check"

    def CloseDesktop(self, handle):
        self.events.append(("close_desktop", handle))
        return True

    def CreateJobObjectW(self, *_):
        self.events.append(("job",))
        return 0 if self.fail == "job" else 60

    def SetInformationJobObject(self, handle, key, info, size):
        assert info._obj.BasicLimitInformation.LimitFlags == 0x2000
        return self.fail != "job_limit"

    def GetCurrentProcess(self):
        return 7

    def DuplicateHandle(self, parent, stream, parent2, output, *_):
        self.handles += 1
        output._obj.value = self.handles
        return self.fail != "duplicate"

    def InitializeProcThreadAttributeList(self, attributes, count, flags, size):
        size._obj.value = 128
        return self.fail != "attributes"

    def UpdateProcThreadAttribute(self, attr, flags, kind, handles, *_):
        self.events.append(("inherited", list(handles)))
        return self.fail != "whitelist"

    def DeleteProcThreadAttributeList(self, *_):
        self.events.append(("delete_attributes",))

    def CreateProcessW(self, executable, command, pa, ta, inherit, flags, env, cwd, startup, info):
        self.events.append(("create", startup._obj.StartupInfo.lpDesktop, flags, inherit, command.value))
        assert pa is ta is None
        if self.fail == "create":
            return False
        info._obj.hProcess, info._obj.hThread, info._obj.dwProcessId = 70, 71, 123
        return True

    def AssignProcessToJobObject(self, job, process):
        self.events.append(("assign", job, process))
        return self.fail != "assign"

    def GetProcessTimes(self, handle, created, *_):
        self.events.append(("identity",))
        value = (11644473600 + 1_790_000_000) * 10_000_000
        created._obj.dwHighDateTime, created._obj.dwLowDateTime = value >> 32, value & 0xffffffff
        return self.fail != "identity"

    def ResumeThread(self, handle):
        self.events.append(("resume", handle))
        return 0xffffffff if self.fail == "resume" else 1

    def CloseHandle(self, handle):
        self.events.append(("close", handle))
        if handle == 60:
            self.running = False
        return True

    def TerminateProcess(self, handle, code):
        self.events.append(("terminate", handle))
        self.running = False
        return True

    def TerminateJobObject(self, handle, code):
        self.events.append(("terminate_job", handle))
        self.running = False
        return True

    def WaitForSingleObject(self, handle, timeout):
        return 0x102 if self.running else 0

    def GetExitCodeProcess(self, handle, output):
        output._obj.value = 0
        return True


class Stream(BytesIO):
    def fileno(self):
        return 3


def launch(api):
    return native._launch_on_desktop(["C:/SC2/SC2_x64.exe", "-dataVersion", "ABC"],
        cwd="C:/SC2", stdout=Stream(), env={"UNICODE": "snowman\u2603"}, api=api, get_osfhandle=lambda fd: fd)


def test_desktop_child_created_suspended_then_owned_identified_and_resumed():
    api = FakeAPI()
    process = launch(api)
    names = [event[0] for event in api.events]
    assert names.index("assign") < names.index("identity") < names.index("resume")
    created = next(event for event in api.events if event[0] == "create")
    assert created[1].startswith("pluto-capture-") and created[2] & 4
    assert created[2] & 0x08000000 and created[2] & 0x80000 and created[3] is True
    assert next(event for event in api.events if event[0] == "inherited")[1] == [21, 22, 23]
    assert process.process_created_at == 1_790_000_000 and process.pid == 123
    process.close()
    process.close()
    assert api.events[-1][0] == "close_desktop"


@pytest.mark.parametrize("failure", ["desktop", "desktop_check", "job", "job_limit", "duplicate",
                                    "attributes", "whitelist", "create", "assign", "identity", "resume"])
def test_failure_never_falls_back_or_resumes_unowned_child(failure):
    api = FakeAPI(fail=failure)
    with pytest.raises(OSError):
        launch(api)
    assert sum(event[0] == "create" for event in api.events) <= 1
    if failure in {"assign", "identity", "resume"}:
        assert ("terminate", 70) in api.events
    if failure not in {"resume"}:
        assert not any(event[0] == "resume" for event in api.events)


def test_input_desktop_rejected_before_process_creation():
    api = FakeAPI(active=True)
    with pytest.raises(RuntimeError, match="input desktop"):
        launch(api)
    assert not any(row[0] == "create" for row in api.events)


def test_desktop_boundary_loss_terminates_only_retained_owned_job():
    api = FakeAPI()
    process = launch(api)
    api.active = True
    with pytest.raises(RuntimeError):
        process.check_background()
    assert ("terminate_job", 60) in api.events
    process.close()


@pytest.mark.parametrize("timeout", [None, float("inf"), float("nan"), -1, 91])
def test_owned_wait_must_be_bounded(timeout):
    process = launch(FakeAPI())
    try:
        with pytest.raises(ValueError):
            process.wait(timeout)
    finally:
        process.close()


def test_no_desktop_switch_or_foreground_window_functions_in_launcher():
    import ast
    tree = ast.parse(Path(native.__file__).read_text())
    banned = {"SwitchDesktop", "SetThreadDesktop", "SetForegroundWindow", "SetProcessWindowStation", "Popen"}
    assert not any(isinstance(node, ast.Attribute) and node.attr in banned for node in ast.walk(tree))


@pytest.fixture
def coordination(tmp_path):
    executable = tmp_path / "agent.exe"
    executable.write_bytes(b"installed agent proof fixture")
    lock = tmp_path / "engine-activity.lock"
    lock.write_bytes(b"0")
    agent = {"pid": 42, "process_created_at": 1700000000, "executable": str(executable)}
    proof = {"schema": "installed-agent-engine-lock-proof-v1", "status": "passed",
        "installed_executable_sha256": capture.digest(executable), **{key: agent[key] for key in ("pid", "process_created_at")},
        "lock_path": str(lock.resolve()), "lock_semantics": "msvcrt-byte0-exclusive",
        "all_native_capture_paths_guarded": True, "busy_lock_defers_capture_without_loss": True}
    return agent, proof, lock


def test_source_only_proof_or_absent_installed_lock_cannot_launch(coordination):
    agent, proof, lock = coordination
    for field in ("all_native_capture_paths_guarded", "busy_lock_defers_capture_without_loss"):
        with pytest.raises(RuntimeError):
            capture.validate_coordination_proof({**proof, field: False}, agent, lock)
    lock.unlink()  # Temporary test fixture only.
    with pytest.raises(RuntimeError, match="absent"):
        capture.validate_coordination_proof(proof, agent, lock)
    assert not lock.exists()


def test_installed_binary_change_and_pid_reuse_rejected(coordination, monkeypatch):
    agent, proof, lock = coordination
    Path(agent["executable"]).write_bytes(b"changed")
    with pytest.raises(RuntimeError):
        capture.validate_coordination_proof(proof, agent, lock)
    monkeypatch.setattr(capture.psutil, "Process", lambda pid: SimpleNamespace(create_time=lambda: 1700000001))
    with pytest.raises(RuntimeError, match="identity"):
        capture.require_identity(agent)


def test_existing_byte_lock_is_claimed_before_engine_inventory_and_held(coordination, monkeypatch):
    agent, proof, lock = coordination
    events = []
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2,
        locking=lambda fd, operation, length: events.append(("lock", operation, length))))
    monkeypatch.setattr(capture, "require_identity", lambda identity: None)
    monkeypatch.setattr(capture.psutil, "process_iter", lambda fields: events.append(("engines",)) or [])
    with capture.EngineLease(agent=agent, state_dir=lock.parent, coordination_proof=proof,
                              deadline=time.monotonic() + 10) as lease:
        lease.check()
        assert events == [("lock", 1, 1), ("engines",)]
    assert events[-1] == ("lock", 2, 1)


def test_active_engine_under_lease_is_rejected_and_unlocked(coordination, monkeypatch):
    agent, proof, lock = coordination
    events = []
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2,
        locking=lambda fd, operation, length: events.append(operation)))
    monkeypatch.setattr(capture, "require_identity", lambda identity: None)
    monkeypatch.setattr(capture.psutil, "process_iter", lambda fields: [SimpleNamespace(info={"name": "SC2_x64.exe"})])
    with pytest.raises(RuntimeError, match="SC2 is active"):
        with capture.EngineLease(agent=agent, state_dir=lock.parent, coordination_proof=proof,
                                  deadline=time.monotonic() + 10):
            pytest.fail("Must not reach owned body")
    assert events == [1, 2]


def test_native_compatibility_never_inferred_from_mock_launcher_success(tmp_path):
    engine = tmp_path / "SC2_x64.exe"
    engine.write_bytes(b"native binary fixture")
    with pytest.raises(RuntimeError, match="compatibility"):
        capture.validate_native_proof({"status": "passed", "cpu_tests": 100}, engine, "ABC")


@pytest.mark.parametrize("gate", ["stop", "deadline"])
def test_stop_and_deadline_are_preserved_and_release_lease(coordination, monkeypatch, gate):
    agent, proof, lock = coordination
    events = []
    marker = lock.parent / "STOP"
    if gate == "stop":
        marker.write_text("User stop; must remain")
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2,
        locking=lambda fd, operation, length: events.append(operation)))
    monkeypatch.setattr(capture, "require_identity", lambda identity: None)
    with pytest.raises(InterruptedError if gate == "stop" else TimeoutError):
        with capture.EngineLease(agent=agent, state_dir=lock.parent, coordination_proof=proof,
                stop_paths=[marker], deadline=time.monotonic() + (10 if gate == "stop" else -1)):
            pytest.fail("Expired or stopped lease must not start capture")
    assert events == [1, 2]
    if gate == "stop":
        assert marker.read_text() == "User stop; must remain"


def test_collector_adapter_requires_native_receipt_before_opening_log(tmp_path, monkeypatch):
    engine = tmp_path / "SC2_x64.exe"
    engine.write_bytes(b"dummy exact engine")
    fake_runner = SimpleNamespace(ManagedSC2Process=type("Managed", (), {}))
    fake_paths = SimpleNamespace(Paths=SimpleNamespace(BASE=tmp_path, CWD=tmp_path),
                                latest_executeble=lambda *args: engine)
    monkeypatch.setitem(sys.modules, "pluto_sc2.runner", fake_runner)
    monkeypatch.setitem(sys.modules, "sc2.paths", fake_paths)
    checks = []
    cls = capture.process_class(SimpleNamespace(check=lambda: checks.append("lease")), tmp_path, {})
    obj = cls()
    obj._sc2_version = None
    obj._base_build, obj._data_hash, obj._render = "Base97563", "ABC", False
    with pytest.raises(RuntimeError, match="compatibility"):
        obj._launch()
    assert checks == ["lease"] and not (tmp_path / "isolated-engine.log").exists()
