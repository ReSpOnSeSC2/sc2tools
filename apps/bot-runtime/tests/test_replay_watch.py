from io import BytesIO
import json
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

from pluto_sc2 import replay_watch as watch


@pytest.fixture
def replay(tmp_path, monkeypatch):
    path = tmp_path / "game & special ' names.SC2Replay"
    path.write_bytes(b"MPQ\x1b" + b"fixture" * 20)
    members = {"replay.details": b"details", "replay.initData": b"init",
               "replay.game.events": b"events", "replay.gamemetadata.json": json.dumps({
                   "Players": [{"PlayerID": 1}], "BaseBuild": 97563,
                   "GameVersion": "5.0.16", "MapName": "Test map"}).encode()}

    class Archive:
        def __init__(self, source):
            assert isinstance(source, BytesIO)

        def read_file(self, name):
            return members.get(name)

    monkeypatch.setattr(watch.mpyq, "MPQArchive", Archive)
    return path, members


def test_normal_viewer_uses_argument_list_and_no_training_api(replay, tmp_path, monkeypatch):
    path, _ = replay
    root = tmp_path / "StarCraft II"
    switcher = root / "Support" / "SC2Switcher.exe"
    switcher.parent.mkdir(parents=True)
    switcher.write_bytes(b"launcher")
    launched = []
    monkeypatch.setattr(watch.sys, "platform", "win32")
    monkeypatch.setattr(watch.subprocess, "Popen", lambda args, **kwargs:
                        launched.append((args, kwargs)) or SimpleNamespace(pid=9123))
    monkeypatch.setattr(watch.psutil, "Process", lambda pid: SimpleNamespace(create_time=lambda: 1234.0))
    result = watch.launch_native_replay(path, root)
    assert launched[0][0] == [str(switcher), str(path)]
    assert launched[0][1]["shell"] is False
    assert launched[0][1]["cwd"] == str(switcher.parent)
    assert result["status"] == "launch_requested" and result["launcher_pid"] == 9123
    assert result["launcher_created_at"] == 1234.0
    assert result["map_name"] == "Test map"


@pytest.mark.parametrize("member", ["replay.details", "replay.initData", "replay.game.events",
                                  "replay.gamemetadata.json"])
def test_partial_archive_is_rejected_before_launch(replay, member, monkeypatch):
    path, members = replay
    members.pop(member)
    monkeypatch.setattr(watch.sys, "platform", "win32")
    monkeypatch.setattr(watch.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("must not launch"))
    with pytest.raises(ValueError, match="not ready"):
        watch.launch_replay(path)


def test_changing_file_is_rejected(replay, monkeypatch):
    path, _ = replay
    original = Path.read_bytes

    def changing_read(target):
        contents = original(target)
        target.write_bytes(contents + b"another write")
        return contents

    monkeypatch.setattr(Path, "read_bytes", changing_read)
    with pytest.raises(ValueError, match="still being written"):
        watch.validate_replay(path)


@pytest.mark.parametrize("filename,data", [("missing.SC2Replay", None), ("empty.SC2Replay", b""),
                                          ("wrong.exe", b"MPQ\x1b"), ("partial.SC2Replay", b"partial")])
def test_invalid_paths_do_not_launch(filename, data, tmp_path, monkeypatch):
    path = tmp_path / filename
    if data is not None:
        path.write_bytes(data)
    monkeypatch.setattr(watch.sys, "platform", "win32")
    monkeypatch.setattr(watch.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("must not launch"))
    with pytest.raises(ValueError):
        watch.launch_replay(path)


def test_requested_install_does_not_silently_fall_back(tmp_path, monkeypatch):
    monkeypatch.setenv("SC2PATH", "C:/Program Files (x86)/StarCraft II")
    with pytest.raises(ValueError, match="not found"):
        watch._find_switcher(tmp_path)


def test_environment_install_and_64bit_layout(tmp_path, monkeypatch):
    switcher = tmp_path / "Support64" / "SC2Switcher_x64.exe"
    switcher.parent.mkdir()
    switcher.write_bytes(b"launcher")
    monkeypatch.setenv("SC2PATH", str(tmp_path))
    assert watch._find_switcher(None) == switcher


def test_switcher_handoff_can_exit_before_process_lookup(replay, monkeypatch, tmp_path):
    monkeypatch.setattr(watch.sys, "platform", "win32")
    monkeypatch.setattr(watch, "_find_switcher", lambda root: tmp_path / "SC2Switcher.exe")
    monkeypatch.setattr(watch.subprocess, "Popen", lambda *args, **kwargs: SimpleNamespace(pid=123))

    def vanished(pid):
        raise psutil.NoSuchProcess(pid)

    monkeypatch.setattr(watch.psutil, "Process", vanished)
    result = watch.launch_native_replay(replay[0])
    assert result["launcher_pid"] == 123 and result["launcher_created_at"] is None


def test_launcher_failure_is_clear(replay, monkeypatch, tmp_path):
    monkeypatch.setattr(watch.sys, "platform", "win32")
    monkeypatch.setattr(watch, "_find_switcher", lambda root: tmp_path / "SC2Switcher.exe")

    def denied(*args, **kwargs):
        raise PermissionError("access denied")

    monkeypatch.setattr(watch.subprocess, "Popen", denied)
    with pytest.raises(RuntimeError, match="Could not start"):
        watch.launch_replay(replay[0], output_root=tmp_path / "viewers")


def test_isolated_viewer_launch_initializes_controls_and_process_receipt(replay, tmp_path, monkeypatch):
    launched = []
    monkeypatch.setattr(watch.sys, "platform", "win32")
    monkeypatch.setattr(watch.subprocess, "Popen", lambda args, **kwargs:
                        launched.append((args, kwargs)) or SimpleNamespace(pid=4412))
    monkeypatch.setattr(watch.psutil, "Process", lambda pid: SimpleNamespace(create_time=lambda: 123.5))
    result = watch.launch_replay(replay[0], sc2_path=tmp_path / "StarCraft II", output_root=tmp_path / "viewers")
    output = Path(result["viewer_output"])
    assert output.parent == tmp_path / "viewers" and len(result["viewer_id"]) == 32
    command, options = launched[0]
    assert command[1:3] == ["-m", "pluto_sc2.replay_viewer"]
    assert command[command.index("--replay") + 1] == str(replay[0])
    assert command[command.index("--output") + 1] == str(output)
    assert options["shell"] is False
    assert options["creationflags"] == getattr(watch.subprocess, "CREATE_NO_WINDOW", 0)
    assert json.loads((output / "control.json").read_text()) == {"paused": False, "speed": 1.0, "close": False}
    assert json.loads((output / "launch.json").read_text()) == {"pid": 4412, "process_created_at": 123.5}
