"""Portable state lookup must not enable or launch native capture."""
import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "portable_player_capture", Path(__file__).resolve().parents[1] / "scripts/capture_alphastar_player_batch.py")
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


def test_localappdata_is_used_without_touching_files(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "selected-profile"))
    assert capture.default_agent_state_path() == tmp_path / "selected-profile/sc2tools/agent.json"
    assert not list(tmp_path.iterdir())
    assert capture.BACKGROUND_NATIVE_LAUNCH_VERIFIED is False


def test_home_fallback_when_localappdata_is_missing(tmp_path, monkeypatch):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert capture.default_agent_state_path() == tmp_path / "AppData/Local/sc2tools/agent.json"


def test_empty_localappdata_uses_home(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", "")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert capture.default_agent_state_path() == tmp_path / "AppData/Local/sc2tools/agent.json"
