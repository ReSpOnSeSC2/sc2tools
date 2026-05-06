"""Tests for player_handle: cloud→cache→env-var resolution."""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sc2tools_agent import player_handle


@pytest.fixture(autouse=True)
def _clear_handle_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip the env vars on every test so global state doesn't leak."""
    monkeypatch.delenv("SC2TOOLS_PLAYER_HANDLE", raising=False)
    monkeypatch.delenv("SC2TOOLS_PLAYER_CONFIG", raising=False)


def test_resolve_returns_none_when_nothing_configured(tmp_path: Path) -> None:
    assert player_handle.resolve(tmp_path) is None


def test_resolve_falls_back_to_env_handle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SC2TOOLS_PLAYER_HANDLE", "EnvName#5555")
    assert player_handle.resolve(tmp_path) == "EnvName#5555"


def test_resolve_falls_back_to_legacy_config_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = tmp_path / "overlay-config.json"
    cfg.write_text(json.dumps({"last_player": "OverlayName"}), encoding="utf-8")
    monkeypatch.setenv("SC2TOOLS_PLAYER_CONFIG", str(cfg))
    assert player_handle.resolve(tmp_path) == "OverlayName"


def test_cache_takes_priority_over_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SC2TOOLS_PLAYER_HANDLE", "EnvName")
    player_handle.write_cache(tmp_path, "CloudName#0001")
    assert player_handle.resolve(tmp_path) == "CloudName#0001"


def test_write_cache_then_read_cache_roundtrips(tmp_path: Path) -> None:
    player_handle.write_cache(tmp_path, "RoundTrip#0001")
    assert player_handle.read_cache(tmp_path) == "RoundTrip#0001"
    # File location is stable.
    assert (tmp_path / "player_handle.json").exists()


def test_write_cache_with_none_clears_existing(tmp_path: Path) -> None:
    player_handle.write_cache(tmp_path, "ToClear")
    player_handle.write_cache(tmp_path, None)
    assert player_handle.read_cache(tmp_path) is None
    assert not (tmp_path / "player_handle.json").exists()


def test_read_cache_recovers_from_corrupt_file(tmp_path: Path) -> None:
    (tmp_path / "player_handle.json").write_text(
        "{not valid json", encoding="utf-8",
    )
    assert player_handle.read_cache(tmp_path) is None


def test_refresh_from_cloud_writes_battletag(tmp_path: Path) -> None:
    """battleTag is used when displayName isn't set, but the
    discriminator is stripped because SC2 doesn't put it in the
    in-replay player name."""
    api = MagicMock()
    api.get_profile.return_value = {
        "battleTag": "Cloud#1234",
        "pulseId": "999",
    }
    handle = player_handle.refresh_from_cloud(api, tmp_path)
    assert handle == "Cloud"  # discriminator stripped, NOT "Cloud#1234"
    assert player_handle.read_cache(tmp_path) == "Cloud"


def test_refresh_from_cloud_prefers_display_name_over_battletag(
    tmp_path: Path,
) -> None:
    """When both displayName and battleTag are set (the common case
    after the user fills out their web profile), displayName wins —
    it's the cleanest match against the in-replay player name."""
    api = MagicMock()
    api.get_profile.return_value = {
        "displayName": "ReSpOnSe",
        "battleTag": "ReSpOnSe#1872",
        "pulseId": "994428",
    }
    handle = player_handle.refresh_from_cloud(api, tmp_path)
    assert handle == "ReSpOnSe"


def test_refresh_from_cloud_battletag_without_discriminator(
    tmp_path: Path,
) -> None:
    """A battleTag with no '#' (legacy/edge case) returns as-is."""
    api = MagicMock()
    api.get_profile.return_value = {"battleTag": "JustAName"}
    handle = player_handle.refresh_from_cloud(api, tmp_path)
    assert handle == "JustAName"


def test_refresh_from_cloud_falls_back_to_pulse_id(tmp_path: Path) -> None:
    api = MagicMock()
    api.get_profile.return_value = {"pulseId": "123456"}
    handle = player_handle.refresh_from_cloud(api, tmp_path)
    assert handle == "123456"
    assert player_handle.read_cache(tmp_path) == "123456"


def test_refresh_from_cloud_handles_empty_profile(tmp_path: Path) -> None:
    api = MagicMock()
    api.get_profile.return_value = {}
    assert player_handle.refresh_from_cloud(api, tmp_path) is None
    # No cache written when cloud has nothing.
    assert player_handle.read_cache(tmp_path) is None


def test_refresh_swallows_network_errors_and_keeps_existing_cache(
    tmp_path: Path,
) -> None:
    """If the cloud call fails, the existing on-disk cache must
    survive — that's the whole point of the offline fallback."""
    player_handle.write_cache(tmp_path, "Existing#0001")
    api = MagicMock()
    api.get_profile.side_effect = ConnectionError("offline")
    assert player_handle.refresh_from_cloud(api, tmp_path) is None
    assert player_handle.read_cache(tmp_path) == "Existing#0001"


# -------------------------------------------------------------------------
# Auto-detect from replays
# -------------------------------------------------------------------------


def test_auto_detect_returns_none_when_no_folders():
    assert player_handle.auto_detect_from_replays([]) is None


def test_auto_detect_returns_none_when_folder_missing(tmp_path: Path):
    missing = tmp_path / "nope"
    assert player_handle.auto_detect_from_replays([missing]) is None


def test_auto_detect_returns_none_when_no_replays(tmp_path: Path):
    # Empty SC2-shaped folder. The function must not crash; it returns
    # None so the runner falls through to the "uploads disabled" warning.
    folder = tmp_path / "Accounts" / "111" / "1-S2-1-2" / "Replays" / "Multiplayer"
    folder.mkdir(parents=True)
    assert player_handle.auto_detect_from_replays([folder]) is None


def test_auto_detect_resolves_real_replay():
    """Run against a real bundled replay fixture if one exists.

    The agent worktree includes the user's actual SC2 replays only on
    a developer's box, so we skip when the canonical fixture path is
    missing rather than failing CI."""
    fixture_folder = Path(
        "C:/Users/jay19/OneDrive/Pictures/Documents/StarCraft II/"
        "Accounts/50983875/1-S2-1-267727/Replays/Multiplayer",
    )
    if not fixture_folder.exists():
        pytest.skip("real-replay fixture not present on this host")
    out = player_handle.auto_detect_from_replays([fixture_folder], max_scan=3)
    # Whatever the latest replay reveals, it must be a non-empty string.
    assert isinstance(out, str) and out
