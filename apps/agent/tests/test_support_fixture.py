"""Fixed resource and isolated-child contracts; never parse or launch a child."""
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import shutil
import sys
import time
from types import SimpleNamespace

import pytest

from sc2tools_agent import support_fixture as fixture


def test_packaged_resource_bytes_notice_and_fixed_perspective_are_pinned(tmp_path):
    replay = fixture.resource_bytes()
    assert len(replay) == 63353
    assert hashlib.sha256(replay).hexdigest() == "4bc930864e08f1bc5de1e5ce7e2af70d4bf49f8b2c3fe1f00fef26e4e8c8fc23"
    root = fixture.resource_root()
    notice = (root / "sc2reader-LICENSE.txt").read_bytes()
    assert len(notice) == 1129 and hashlib.sha256(notice).hexdigest() == fixture.LICENSE_SHA256
    assert b"Copyright (c) 2011-2013 Graylin Kim" in notice and b"THE SOFTWARE IS PROVIDED" in notice
    assert json.loads((root / "manifest.json").read_text())["player_toon"] == "5-S2-1-526043"
    copied = tmp_path / "resources"
    shutil.copytree(root, copied)
    (copied / "diagnostic.SC2Replay").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="unavailable"):
        fixture.resource_bytes(copied)


def test_source_and_frozen_commands_use_only_dedicated_mode(monkeypatch):
    monkeypatch.delattr(fixture.sys, "frozen", raising=False)
    source = fixture.child_command()
    assert source[0] == sys.executable and source[1] == "-I" and source[-1] == "--support-fixture-check"
    assert Path(source[2]).name == "__main__.py"
    monkeypatch.setattr(fixture.sys, "frozen", True, raising=False)
    assert fixture.child_command() == [sys.executable, "--support-fixture-check"]


def test_child_environment_explicit_whitelist_does_not_mutate_parent(tmp_path):
    parent = {"SYSTEMROOT": r"C:\Windows", "PATH": "private-path", "PYTHONPATH": "private-modules",
        "SC2TOOLS_DEVICE_TOKEN": "private-token", "SC2TOOLS_OBS_PASSWORD": "private-password",
        "SC2TOOLS_PLAYER_HANDLE": "private-player", "SC2TOOLS_OBSERVATION_DIR": "private-observation",
        "SC2TOOLS_GUI_SMOKE_REPORT": "private-smoke", "HOME": "private-home"}
    before = dict(parent)
    child = fixture.child_environment(parent, tmp_path)
    assert parent == before
    assert set(child) == {"SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "PYTHONIOENCODING", "PYTHONNOUSERSITE"}
    assert child["TEMP"] == str(tmp_path) and not any("private" in value for value in child.values())


def test_early_entry_dispatch_never_calls_normal_bootstrap(monkeypatch):
    from sc2tools_agent import __main__ as entry
    calls = []
    monkeypatch.setattr(entry, "run_agent", lambda: (_ for _ in ()).throw(AssertionError("normal agent bootstrap")))
    monkeypatch.setattr(fixture, "fixture_main", lambda: calls.append("fixture") or 0)
    monkeypatch.setenv("SC2TOOLS_GUI_SMOKE_REPORT", "must-not-run-smoke")
    assert entry.main(["--support-fixture-check"]) == 0
    assert calls == ["fixture"]
    assert entry.main(["--support-fixture-check", "private-argument"]) == 2


def test_child_helper_discards_payload_and_uses_explicit_no_capabilities(monkeypatch, capsys):
    observed = []

    class Options:
        def __init__(self, **kwargs):
            observed.append(kwargs)

    def parse(data, **kwargs):
        observed.append(kwargs)
        assert data == b"public-fixture"
        print("private-payload-output")
        return {"ok": True, "payload": {"myToonHandle": "private-toon", "battleTag": "private-player"}}

    monkeypatch.setattr(fixture, "resource_bytes", lambda: b"public-fixture")
    monkeypatch.setitem(sys.modules, "sc2tools_agent.instant_analysis", SimpleNamespace(RuntimeOptions=Options, parse_replay_bytes=parse))
    monkeypatch.setitem(sys.modules, "sc2tools_agent.replay_pipeline", SimpleNamespace(probe_analyzer=lambda: (True, "private-diagnostic")))
    import logging
    monkeypatch.setattr(logging, "disable", lambda _level: None)
    assert fixture.fixture_main() == 0
    output = capsys.readouterr()
    assert json.loads(output.out) == {"version": 1, "ok": True, "code": "ok"}
    assert "private" not in output.out + output.err
    assert observed[0] == {"player_toon": "5-S2-1-526043", "threads": False, "file_caches": False,
        "network_lookups": False, "engine_capture": False}
    assert observed[1]["filename"] == "diagnostic.SC2Replay"


def test_windowed_child_without_python_stdout_emits_only_status(monkeypatch):
    captured = []
    monkeypatch.setattr(logging, "disable", lambda _level: None)
    monkeypatch.setattr(fixture.sys, "stdout", None)
    monkeypatch.setattr(fixture, "resource_bytes", lambda: (_ for _ in ()).throw(ValueError("private-source-detail")))
    monkeypatch.setattr(fixture, "_write_windows_status", lambda data: captured.append(data) or True)
    assert fixture.fixture_main() == 0
    assert captured == [b'{"version":1,"ok":false,"code":"unavailable"}\n']


def test_windowed_missing_borrowed_output_handle_fails_closed(monkeypatch):
    monkeypatch.setattr(fixture.sys, "stdout", None)
    monkeypatch.setattr(fixture, "_write_windows_status", lambda _data: False)
    assert fixture._emit_status(False, "unavailable") == 1


@pytest.mark.skipif(os.name != "nt", reason="Windows inherited pipe adapter")
def test_windowed_status_writer_writes_exact_bytes_to_owned_pipe_without_closing_it(monkeypatch):
    import msvcrt
    reader, writer = os.pipe()
    status = b'{"version":1,"ok":true,"code":"ok"}\n'
    try:
        monkeypatch.setattr(fixture, "_inherited_stdout", lambda _kernel: msvcrt.get_osfhandle(writer))
        assert fixture._write_windows_status(status) is True
        assert os.read(reader, len(status)) == status
        # The writer is borrowed; its owner can still use and close it.
        assert os.write(writer, b"x") == 1 and os.read(reader, 1) == b"x"
        assert fixture._write_windows_status(b"x" * 1025) is False
    finally:
        os.close(writer)
        os.close(reader)


@pytest.mark.skipif(os.name != "nt", reason="Windows inherited pipe adapter")
def test_windowed_status_writer_rejects_a_disk_handle_without_writing(tmp_path, monkeypatch):
    import msvcrt
    path = tmp_path / "untouched.txt"
    with path.open("w+b") as stream:
        stream.write(b"synthetic existing content")
        stream.flush()
        monkeypatch.setattr(fixture, "_inherited_stdout", lambda _kernel: msvcrt.get_osfhandle(stream.fileno()))
        result = fixture._write_windows_status(b"status")
    assert path.read_bytes() == b"synthetic existing content"
    assert result is False


def test_real_isolated_public_fixture_roundtrip_has_no_agent_bootstrap(tmp_path, monkeypatch):
    """Exercise only the dedicated public-fixture child, never run_agent."""
    monkeypatch.setattr(fixture.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setenv("SC2TOOLS_DEVICE_TOKEN", "synthetic-token-must-not-inherit")
    monkeypatch.setenv("SC2TOOLS_OBS_PASSWORD", "synthetic-password-must-not-inherit")
    result = fixture.run_fixture(is_current=lambda: True, is_cancelled=lambda: False,
        deadline=time.monotonic() + 20)
    assert result["status"] == "pass" and result["code"] == "ok"
    assert 0 <= result["latency_ms"] <= 20_000
    assert "synthetic" not in repr(result)
    assert list(tmp_path.iterdir()) == []


class Process:
    def __init__(self, output=b'{"version":1,"ok":true,"code":"ok"}\n', *, held=False):
        self.stdout, self.stderr = io.BytesIO(output), io.BytesIO()
        self.returncode, self.held, self.reaped, self.terminated = None, held, False, False

    def poll(self):
        if not self.held:
            self.returncode = 0
        return self.returncode

    def terminate(self):
        self.terminated, self.returncode = True, -15

    def kill(self):
        self.returncode = -9

    def wait(self, **_kwargs):
        self.reaped = True
        return self.returncode


def test_parent_accepts_only_tiny_status_and_reaps_before_temp_cleanup(tmp_path, monkeypatch):
    monkeypatch.setenv("SC2TOOLS_OBS_PASSWORD", "must-not-inherit")
    process, captured = Process(), []

    def factory(command, **kwargs):
        captured.append((command, kwargs))
        assert Path(kwargs["cwd"]).is_dir()
        assert "SC2TOOLS_OBS_PASSWORD" not in kwargs["env"]
        return process

    result = fixture.run_fixture(is_current=lambda: True, is_cancelled=lambda: False,
        deadline=time.monotonic() + 3, process_factory=factory)
    assert result["status"] == "pass" and result["code"] == "ok" and process.reaped
    assert not Path(captured[0][1]["cwd"]).exists()
    assert "must-not-inherit" not in repr(result)


@pytest.mark.parametrize("reason", ["timeout", "cancelled", "oversize"])
def test_owned_child_timeout_cancel_and_output_overflow_are_reaped(reason):
    process = Process(b"x" * 1025 if reason == "oversize" else b"", held=True)
    calls = []

    def current():
        calls.append(True)
        return not (reason == "cancelled" and len(calls) > 2)

    result = fixture.run_fixture(is_current=current, is_cancelled=lambda: False,
        deadline=time.monotonic() + (3 if reason == "oversize" else 0.03), process_factory=lambda *_args, **_kwargs: process)
    assert process.reaped and process.terminated
    assert result["code"] == {"timeout": "timeout", "cancelled": "cancelled", "oversize": "invalid_response"}[reason]
    assert "x" * 100 not in repr(result)
