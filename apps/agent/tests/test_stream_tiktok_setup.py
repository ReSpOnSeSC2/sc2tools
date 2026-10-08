from pathlib import Path
from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming.obs_reader import OutputReader
from sc2tools_agent.streaming.service import StreamService
from sc2tools_agent.streaming.tiktok_studio import TikTokStudio, discover_studio
from sc2tools_agent.streaming.youtube_pair_backend import PairBackend


class Camera:
    def __init__(self, *, active=False, width=1920, height=1080):
        self.active, self.width, self.height = active, width, height
        self.actions = []

    def get_virtual_cam_status(self):
        return SimpleNamespace(output_active=self.active)

    def get_video_settings(self):
        return SimpleNamespace(base_width=self.width, base_height=self.height)

    def start_virtual_cam(self):
        self.actions.append("start_virtual_cam")
        self.active = True

    def stop_virtual_cam(self):
        self.actions.append("stop_virtual_cam")
        self.active = False

    def disconnect(self):
        pass


def test_camera_status_is_read_only_and_actions_are_explicit_idempotent():
    camera = Camera()
    reader = OutputReader(lambda: {}, factory=lambda **kwargs: camera)
    assert reader.virtual_camera_status()["virtual_camera_active"] is False
    assert camera.actions == []
    assert reader.set_virtual_camera(True)["virtual_camera_active"] is True
    reader.set_virtual_camera(True)
    assert camera.actions == ["start_virtual_cam"]
    assert reader.set_virtual_camera(False)["virtual_camera_active"] is False
    assert camera.actions == ["start_virtual_cam", "stop_virtual_cam"]


def test_portrait_main_canvas_cannot_start_tiktok_camera():
    camera = Camera(width=1080, height=1920)
    reader = OutputReader(lambda: {}, factory=lambda **kwargs: camera)
    with pytest.raises(ValueError, match="landscape"):
        reader.set_virtual_camera(True)
    assert camera.actions == []


def test_disabled_obs_camera_never_opens_connection():
    def forbidden(**kwargs):
        raise AssertionError("Must not connect")
    reader = OutputReader(lambda: {}, disabled=True, factory=forbidden)
    assert reader.virtual_camera_status()["virtual_camera_active"] is None
    with pytest.raises(ValueError, match="disabled"):
        reader.set_virtual_camera(True)


def test_camera_failed_readback_does_not_retry_start():
    camera = Camera()
    camera.start_virtual_cam = lambda: camera.actions.append("start_virtual_cam")
    reader = OutputReader(lambda: {}, factory=lambda **kwargs: camera)
    with pytest.raises(ValueError, match="could not be verified"):
        reader.set_virtual_camera(True)
    assert camera.actions == ["start_virtual_cam"]


def test_camera_provider_error_never_exposes_connection_credentials():
    def broken(**kwargs):
        raise ValueError("secret OBS password")
    reader = OutputReader(lambda: {}, factory=broken)
    assert "secret" not in str(reader.virtual_camera_status())
    with pytest.raises(ValueError) as failure:
        reader.set_virtual_camera(True)
    assert "secret" not in str(failure.value)


def test_discovery_prefers_launcher_and_reports_latest_version(tmp_path, monkeypatch):
    from sc2tools_agent.streaming import tiktok_studio
    monkeypatch.setattr(tiktok_studio.sys, "platform", "win32")
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    root = tmp_path / "TikTok LIVE Studio"
    for version in ("1.9.0", "1.36.6"):
        folder = root / version
        folder.mkdir(parents=True)
        (folder / "TikTok LIVE Studio.exe").touch()
    assert discover_studio()["path"] == root / "1.36.6" / "TikTok LIVE Studio.exe"
    launcher = root / "TikTok LIVE Studio Launcher.exe"
    launcher.touch()
    assert discover_studio() == {"path": launcher, "version": "1.36.6"}


def test_studio_launch_is_only_explicit_and_missing_install_has_clear_message():
    launches = []
    path = Path("C:/Program Files/TikTok LIVE Studio/TikTok LIVE Studio Launcher.exe")
    studio = TikTokStudio(discover=lambda: {"path": path, "version": "1.36.6"},
                          running=lambda: False, launch=launches.append)
    assert studio.status()["installed"] is True
    assert launches == []
    studio.launch()
    assert launches == [path]
    already_open = TikTokStudio(discover=studio.discover, running=lambda: True, launch=launches.append)
    already_open.launch()
    assert launches == [path]
    with pytest.raises(ValueError, match="Install TikTok"):
        TikTokStudio(discover=lambda: None, running=lambda: False, launch=launches.append).launch()


def test_tiktok_service_check_and_launch_never_start_camera_or_streams(tmp_path):
    launches = []
    camera = Camera()
    backend = PairBackend(tmp_path, memory=True)
    service = StreamService(tmp_path, lambda: {}, backend=backend,
        output_reader=OutputReader(lambda: {}, factory=lambda **kwargs: camera),
        tiktok_studio=TikTokStudio(discover=lambda: {"path": Path("studio.exe"), "version": "1.36.6"},
                                  running=lambda: False, launch=launches.append))
    assert service.status()["tiktok"]["installed"] is None
    assert camera.actions == launches == []
    status = service.action({"action": "check_tiktok"})
    assert status["tiktok"]["main_width"] == 1920
    assert status["platforms"]["tiktok"]["connected"] is False
    assert camera.actions == launches == []
    service.action({"action": "launch_tiktok"})
    assert launches == [Path("studio.exe")]
    assert camera.actions == []
    service.action({"action": "start_virtual_camera"})
    assert camera.actions == ["start_virtual_cam"]
    service.action({"action": "stop_virtual_camera"})
    assert camera.actions == ["start_virtual_cam", "stop_virtual_cam"]
    assert backend.state.get("pair") is None
