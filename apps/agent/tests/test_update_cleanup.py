"""Installer downloads and interrupted-save temp files are deleted, and nothing else."""
import logging
import os
from pathlib import Path
from types import SimpleNamespace

from sc2tools_agent import runner, update_cleanup
from sc2tools_agent.update_cleanup import (start_update_cleanup, sweep_installers, sweep_state_temp_files,
                                           sweep_update_leftovers, updates_dir)

NOW = 1_800_000_000.0
HOUR = 3600.0


def make(directory, name, *, age=0.0, data=b"setup"):
    path = Path(directory) / name
    path.write_bytes(data)
    os.utime(path, (NOW - age, NOW - age))
    return path


def names(directory):
    return sorted(path.name for path in Path(directory).iterdir())


def test_setups_up_to_the_running_version_go_and_newer_ones_stay(tmp_path):
    for name in ("SC2ToolsAgent-Setup-0.15.0.exe", "SC2ToolsAgent-Setup-0.25.5.exe",
                 "SC2ToolsAgent-Setup-0.25.6.exe", "sc2toolsagent-setup-0.25.4.EXE",
                 "SC2ToolsAgent-Setup-0.25.6-rc.1.exe", "SC2ToolsAgent-Setup-0.25.7.exe",
                 "SC2ToolsAgent-Setup-0.26.0-rc.1.exe", "SC2ToolsAgent-Setup-1.0.exe"):
        make(tmp_path, name, age=10 * HOUR)
    result = sweep_installers(tmp_path, "0.25.6", now=NOW)
    assert names(tmp_path) == ["SC2ToolsAgent-Setup-0.25.7.exe", "SC2ToolsAgent-Setup-0.26.0-rc.1.exe",
                               "SC2ToolsAgent-Setup-1.0.exe"]
    assert (result.removed, result.freed_bytes, result.locked) == (5, 5 * len(b"setup"), 0)


def test_staging_copies_go_when_old_or_not_newer_and_downloads_in_progress_stay(tmp_path):
    make(tmp_path, ".SC2ToolsAgent-Setup-0.25.5-ab12cd_9.exe.part")                 # older version, fresh
    make(tmp_path, ".SC2ToolsAgent-Setup-0.25.6-zz00zz00.exe")                      # lock fallback, this version
    make(tmp_path, ".SC2ToolsAgent-Setup-0.25.7-k3k3k3k3.exe.part", age=2 * HOUR)   # abandoned newer download
    make(tmp_path, ".SC2ToolsAgent-Setup-0.25.7-q1q1q1q1.exe", age=2 * HOUR)        # stale newer fallback
    make(tmp_path, ".SC2ToolsAgent-Setup-0.25.7-n0w0n0w0.exe.part", age=60)         # download in progress
    make(tmp_path, ".SC2ToolsAgent-Setup-0.25.0-rc.1-abcdefgh.exe.part")            # pre-release staging
    sweep_installers(tmp_path, "0.25.6", now=NOW)
    assert names(tmp_path) == [".SC2ToolsAgent-Setup-0.25.7-n0w0n0w0.exe.part"]


def test_only_the_agents_exact_names_are_touched(tmp_path):
    keep = ["SC2ToolsAgent-Setup-0.25.4.exe.sha256", "SC2ToolsAgent-Setup-latest.exe", "OtherApp-Setup-0.1.exe",
            "SC2ToolsAgent-Setup-0.25.4.exe.bak", "my SC2ToolsAgent-Setup-0.25.4.exe", "SC2ToolsAgent-Setup-0.25.4.msi",
            ".SC2ToolsAgent-Setup-0.25.4-short.exe.part", ".SC2ToolsAgent-Setup-0.25.4-abcdefghi.exe.part",
            "SC2ToolsAgent-Setup-0.25.4.exe.part", "agent.json"]
    for name in keep:
        make(tmp_path, name, age=48 * HOUR)
    (tmp_path / "SC2ToolsAgent-Setup-0.1.0.exe").mkdir()  # a folder with a setup's name
    (tmp_path / "sc2tools-preview-0GD4I2").mkdir()
    assert sweep_installers(tmp_path, "0.25.6", now=NOW).removed == 0
    assert names(tmp_path) == sorted(keep + ["SC2ToolsAgent-Setup-0.1.0.exe", "sc2tools-preview-0GD4I2"])


def test_an_unparseable_running_version_deletes_no_setup(tmp_path):
    make(tmp_path, "SC2ToolsAgent-Setup-0.1.0.exe", age=48 * HOUR)
    make(tmp_path, ".SC2ToolsAgent-Setup-0.1.0-abcdefgh.exe.part", age=2 * HOUR)
    sweep_installers(tmp_path, "dev", now=NOW)
    assert names(tmp_path) == ["SC2ToolsAgent-Setup-0.1.0.exe"]  # only the stale partial went


def test_a_setup_in_use_is_counted_and_kept(tmp_path, monkeypatch):
    held = make(tmp_path, "SC2ToolsAgent-Setup-0.25.6.exe")
    make(tmp_path, "SC2ToolsAgent-Setup-0.25.5.exe")
    real_unlink = os.unlink

    def unlink(path, *args, **kwargs):
        if Path(path) == held:
            raise PermissionError(32, "The process cannot access the file")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(update_cleanup.os, "unlink", unlink)
    result = sweep_installers(tmp_path, "0.25.6", now=NOW)
    assert (result.removed, result.locked) == (1, 1) and names(tmp_path) == [held.name]


def test_missing_or_unreadable_folders_are_quiet(tmp_path):
    assert sweep_installers(tmp_path / "missing", "0.25.6").removed == 0
    file_path = make(tmp_path, "not-a-folder")
    assert sweep_installers(file_path, "0.25.6").removed == 0


def test_stale_interrupted_save_files_go_and_everything_else_stays(tmp_path):
    old = ["agent.jt5694vz.tmp", "agent.qpu9_378.tmp", "agent-credentials-" + "0123456789abcdef" * 2 + ".tmp"]
    fresh = ["agent.abcdefgh.tmp", "agent-credentials-" + "f" * 32 + ".tmp"]
    other = ["agent.json", "agent.json.tmp", "agent-credentials-xyz.tmp", "player_handle.abcdefgh.tmp",
             "recent-games-abc.tmp", "agent.abc.tmp", "agent.abcdefghi.tmp"]
    for name in old + other:
        make(tmp_path, name, age=2 * HOUR)
    for name in fresh:
        make(tmp_path, name, age=60)
    (tmp_path / "credentials-v1").mkdir()
    make(tmp_path / "credentials-v1", "agent.abcdefgh.tmp", age=48 * HOUR)  # never descends
    result = sweep_state_temp_files(tmp_path, now=NOW)
    assert result.removed == 3
    assert names(tmp_path) == sorted(fresh + other + ["credentials-v1"])
    assert names(tmp_path / "credentials-v1") == ["agent.abcdefgh.tmp"]


def test_one_pass_covers_updates_state_and_only_a_given_temp_folder(tmp_path, monkeypatch):
    state, temp, real_temp = tmp_path / "state", tmp_path / "temp", tmp_path / "real-temp"
    for folder in (updates_dir(state), temp, real_temp):
        folder.mkdir(parents=True)
    make(updates_dir(state), "SC2ToolsAgent-Setup-0.25.6.exe")
    make(updates_dir(state), "SC2ToolsAgent-Setup-0.25.7.exe")
    make(temp, "SC2ToolsAgent-Setup-0.24.7.exe")
    make(real_temp, "SC2ToolsAgent-Setup-0.24.9.exe")
    make(state, "agent.jt5694vz.tmp", age=2 * HOUR)
    monkeypatch.setattr(update_cleanup.tempfile, "gettempdir", lambda: str(real_temp))
    assert updates_dir(state) == state / "updates"
    assert update_cleanup.system_temp_dir() == real_temp
    result = sweep_update_leftovers(state, "0.25.6", now=NOW)  # no temp folder given
    assert result.removed == 2 and names(real_temp) == ["SC2ToolsAgent-Setup-0.24.9.exe"]
    assert names(updates_dir(state)) == ["SC2ToolsAgent-Setup-0.25.7.exe"]
    assert sweep_update_leftovers(state, "0.25.6", temp_dir=temp, now=NOW).removed == 1
    assert names(temp) == []


def test_background_sweep_retries_once_when_the_installer_still_holds_its_file(tmp_path, monkeypatch, caplog):
    temp = tmp_path / "temp"
    temp.mkdir()
    held = make(temp, "SC2ToolsAgent-Setup-0.25.6.exe")
    real_unlink, waits = os.unlink, []
    locked = {"value": True}

    def unlink(path, *args, **kwargs):
        if Path(path) == held and locked["value"]:
            raise PermissionError(32, "in use")
        return real_unlink(path, *args, **kwargs)

    def wait(seconds):
        waits.append(seconds)
        locked["value"] = False  # the installer exited meanwhile
        return False

    monkeypatch.setattr(update_cleanup.os, "unlink", unlink)
    with caplog.at_level(logging.INFO, logger="sc2tools_agent.update_cleanup"):
        thread = start_update_cleanup(tmp_path / "state", "0.25.6", temp_dir=temp, retry_after=7, wait=wait)
        thread.join(5)
    assert thread.daemon and thread.name == "sc2tools-update-cleanup"
    assert waits == [7] and names(temp) == []
    assert "update_cleanup removed=1 freed_mb=0.0 locked=0" in caplog.text


def test_background_sweep_skips_the_retry_when_stopping_and_never_raises(tmp_path, monkeypatch):
    temp = tmp_path / "temp"
    temp.mkdir()
    held = make(temp, "SC2ToolsAgent-Setup-0.25.6.exe")
    monkeypatch.setattr(update_cleanup.os, "unlink", lambda *_a, **_k: (_ for _ in ()).throw(PermissionError(32, "x")))
    waits = []
    start_update_cleanup(tmp_path, "0.25.6", temp_dir=temp, wait=lambda s: waits.append(s) or True).join(5)
    assert waits == [update_cleanup.LOCKED_RETRY_SEC] and held.exists()
    monkeypatch.setattr(update_cleanup, "sweep_update_leftovers", lambda *a, **k: 1 / 0)
    start_update_cleanup(tmp_path, "0.25.6").join(5)  # logged, not raised


def test_runner_downloads_updates_into_the_app_folder(tmp_path, monkeypatch):
    captured, stops = {}, []
    monkeypatch.setattr(runner, "UpdateScheduler", lambda **kwargs: SimpleNamespace(start=lambda _stop: None, **kwargs))
    monkeypatch.setattr(runner, "_running_frozen", lambda: True)
    monkeypatch.setattr(runner, "install_release", lambda release, **kwargs: captured.update(kwargs))
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.example.test")
    scheduler = runner._make_update_scheduler(cfg, SimpleNamespace(), SimpleNamespace(), None, None,
                                              lambda: stops.append(True), logging.getLogger("test"))
    scheduler.install(SimpleNamespace(latest="0.25.7"))
    assert captured == {"download_dir": tmp_path / "updates", "trusted_hosts": ["api.example.test"]}
    assert stops == [True]


def test_runner_sweeps_temp_only_in_the_installed_app(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "start_update_cleanup", lambda state_dir, version, **kwargs: calls.append(
        (state_dir, version, kwargs["temp_dir"])))
    monkeypatch.setattr(runner, "_configure_logging", lambda cfg: tmp_path / "logs")
    monkeypatch.setattr(runner, "init_crash_reporter", lambda **_: None)
    monkeypatch.setattr(runner, "install_crash_capture", lambda *_a, **_k: None)
    monkeypatch.setattr(runner, "can_use_gui", lambda: False)
    monkeypatch.setattr(runner, "_run_headless", lambda *a, **k: 0)
    monkeypatch.setattr(update_cleanup.tempfile, "gettempdir", lambda: str(tmp_path / "temp"))
    cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.example.test")
    args = SimpleNamespace(no_gui=True, start_minimized=False, no_live=True, no_obs=True)
    for frozen in (False, True):
        monkeypatch.setattr(runner, "_running_frozen", lambda frozen=frozen: frozen)
        assert runner._run_locked_agent(cfg, args, []) == 0
    assert calls == [(tmp_path, runner.__version__, None), (tmp_path, runner.__version__, tmp_path / "temp")]
