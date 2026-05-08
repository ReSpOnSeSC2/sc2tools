"""Tests for agent.state - atomic write + round-trip + GUI prefs."""

from __future__ import annotations

import json
from pathlib import Path

from sc2tools_agent.state import AgentState, load_state, save_state


def test_load_state_returns_defaults_when_file_missing(tmp_path: Path) -> None:
    state = load_state(tmp_path)
    assert state.device_token is None
    assert state.user_id is None
    assert state.uploaded == {}
    assert not state.is_paired
    # New GUI defaults.
    assert state.api_base_override is None
    assert state.log_level_override is None
    assert state.autostart_enabled is False
    assert state.start_minimized is False


def test_save_then_load_roundtrips(tmp_path: Path) -> None:
    s = AgentState(
        device_token="t-abc",
        user_id="u-1",
        paired_at="2026-05-04T00:00:00+00:00",
        uploaded={"/path/to/a.SC2Replay": "2026-05-04T00:00:00+00:00"},
    )
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.device_token == "t-abc"
    assert loaded.user_id == "u-1"
    assert loaded.is_paired
    assert loaded.uploaded == s.uploaded


def test_save_writes_atomically(tmp_path: Path) -> None:
    s = AgentState(device_token="abc")
    save_state(tmp_path, s)
    target = tmp_path / "agent.json"
    assert target.exists()
    leftover = list(tmp_path.glob("agent.*.tmp"))
    assert leftover == []
    raw = json.loads(target.read_text(encoding="utf-8"))
    assert raw["device_token"] == "abc"


def test_load_state_recovers_from_corrupt_file(tmp_path: Path) -> None:
    (tmp_path / "agent.json").write_text("{not valid json", encoding="utf-8")
    state = load_state(tmp_path)
    assert state.device_token is None


# ---------------- GUI preferences (introduced with the PySide6 window) ----


def test_gui_preferences_roundtrip(tmp_path: Path) -> None:
    s = AgentState(
        device_token="t-abc",
        api_base_override="https://api.example.com",
        log_level_override="DEBUG",
        autostart_enabled=True,
        start_minimized=True,
    )
    save_state(tmp_path, s)

    loaded = load_state(tmp_path)
    assert loaded.api_base_override == "https://api.example.com"
    assert loaded.log_level_override == "DEBUG"
    assert loaded.autostart_enabled is True
    assert loaded.start_minimized is True


def test_blank_string_overrides_load_as_none(tmp_path: Path) -> None:
    """The GUI saves an empty string when the user clears a field; load
    should normalise that to None so AgentConfig falls back to defaults."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t-abc",
                "api_base_override": "   ",
                "log_level_override": "",
            }
        ),
        encoding="utf-8",
    )

    loaded = load_state(tmp_path)
    assert loaded.device_token == "t-abc"
    assert loaded.api_base_override is None
    assert loaded.log_level_override is None


def test_unknown_keys_are_ignored(tmp_path: Path) -> None:
    """A future agent version might add new state fields. Older agents
    should drop them silently rather than crash."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t-abc",
                "future_field_xyz": True,
                "another_unknown": [1, 2, 3],
            }
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.device_token == "t-abc"


# ---------------- Multi-folder override migration ------------------------


def test_legacy_single_folder_migrates_into_list(tmp_path: Path) -> None:
    """0.3.x agents wrote ``replay_folder_override`` as a bare string.
    On upgrade, that single value should appear in the new list field
    so the user's override is not lost."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t",
                "replay_folder_override": "/legacy/path",
            }
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.replay_folder_override == "/legacy/path"
    assert loaded.replay_folders_override == ["/legacy/path"]


def test_legacy_string_merges_with_modern_list(tmp_path: Path) -> None:
    """If both fields are present (e.g. user upgraded mid-flight), the
    legacy string is merged into the front of the list, deduplicated."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "replay_folder_override": "/x",
                "replay_folders_override": ["/y", "/x"],
            }
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.replay_folders_override == ["/y", "/x"]


def test_modern_list_round_trips(tmp_path: Path) -> None:
    s = AgentState(replay_folders_override=["/a", "/b", "/c"])
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.replay_folders_override == ["/a", "/b", "/c"]


def test_string_in_list_field_is_tolerated(tmp_path: Path) -> None:
    """Defensive parsing — a hand-edited state file that drops a single
    string into the list field should still load."""
    (tmp_path / "agent.json").write_text(
        json.dumps({"replay_folders_override": "/single/raw/string"}),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.replay_folders_override == ["/single/raw/string"]


# ---------------- Sticky-MMR fields --------------------------------------
#
# The cloud session widget falls back to ``profile.lastKnownMmr`` when no
# game in the user's history carries ``myMmr``. The agent persists what
# it last pushed in AgentState so it can gate-keep older replays during
# a backfill (no clobbering a recent MMR with a season-old one) and so a
# brief offline period doesn't make us re-push the same value on the
# next start.


def test_last_known_mmr_round_trips(tmp_path: Path) -> None:
    s = AgentState(
        device_token="t",
        last_known_mmr=4730,
        last_known_mmr_date_iso="2026-05-07T10:00:00Z",
        last_known_mmr_region="NA",
    )
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.last_known_mmr == 4730
    assert loaded.last_known_mmr_date_iso == "2026-05-07T10:00:00Z"
    assert loaded.last_known_mmr_region == "NA"


def test_last_known_mmr_rejects_garbage_and_out_of_range(tmp_path: Path) -> None:
    """Hand-edited state file or a downgrade-after-corruption must not
    re-inject a league-enum value (Bronze=0..GM=7) as a real rating —
    the cloud schema would reject it anyway, so drop it on load."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t",
                # 7 = Grandmaster league enum, the exact value that
                # used to leak into the live overlay before the v0.3.x
                # MMR floor was added.
                "last_known_mmr": 7,
                "last_known_mmr_region": "NA",
            }
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.last_known_mmr is None
    # A bogus MMR must not strand the region — region is a separate
    # field. (We let it round-trip; the queue won't push without an
    # MMR anyway.)
    assert loaded.last_known_mmr_region == "NA"


def test_last_known_mmr_handles_missing_fields(tmp_path: Path) -> None:
    """Older state files have none of the sticky-MMR fields; loading
    must not raise and the new fields default to None."""
    (tmp_path / "agent.json").write_text(
        json.dumps({"device_token": "t"}),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.last_known_mmr is None
    assert loaded.last_known_mmr_date_iso is None
    assert loaded.last_known_mmr_region is None


# ---------------- Sync-filter fields ----------------------------------
#
# The watcher gates uploads through these. Round-trip tests pin down
# both the persisted shape (so a downgrade after upgrade doesn't
# silently lose the user's filter) and the load-time normalisation
# (empty strings → None so a cleared field doesn't ship as a literal
# empty string into SyncFilter).


def test_sync_filter_round_trips(tmp_path: Path) -> None:
    s = AgentState(
        device_token="t",
        sync_filter_preset="season:67",
        sync_filter_since="2026-04-01",
        sync_filter_until="2026-07-01",
    )
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.sync_filter_preset == "season:67"
    assert loaded.sync_filter_since == "2026-04-01"
    assert loaded.sync_filter_until == "2026-07-01"


def test_sync_filter_blank_strings_load_as_none(tmp_path: Path) -> None:
    """The GUI saves an empty string when a non-custom preset is
    chosen. Load should normalise that to None so SyncFilter doesn't
    have to second-guess what an empty string means."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "device_token": "t",
                "sync_filter_preset": "current_season",
                "sync_filter_since": "",
                "sync_filter_until": "   ",
            }
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.sync_filter_preset == "current_season"
    assert loaded.sync_filter_since is None
    assert loaded.sync_filter_until is None


def test_sync_filter_missing_fields_default_to_none(tmp_path: Path) -> None:
    """Older state files (pre-v0.5.6) don't have any sync_filter
    fields. Loading must not raise and the agent treats absence as
    'no filter' — i.e. the legacy upload-everything behaviour."""
    (tmp_path / "agent.json").write_text(
        json.dumps({"device_token": "t"}),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert loaded.sync_filter_preset is None
    assert loaded.sync_filter_since is None
    assert loaded.sync_filter_until is None


def test_dashboard_url_falls_back_to_dot_com() -> None:
    """The default dashboard origin is sc2tools.com — not .app — and the
    runner must produce that fallback whenever no api.* hostname is in
    play. A regression here sends users to a dead domain on first
    launch."""
    from sc2tools_agent.runner import _dashboard_url_from_api

    assert (
        _dashboard_url_from_api("https://sc2tools-api.onrender.com")
        == "https://sc2tools.com"
    )
    assert (
        _dashboard_url_from_api("https://api.sc2tools.com")
        == "https://sc2tools.com"
    )
    assert (
        _dashboard_url_from_api("http://localhost:8080")
        == "http://localhost:3000"
    )
