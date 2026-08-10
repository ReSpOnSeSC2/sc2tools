"""Tests for agent.state - atomic write + round-trip + GUI prefs."""

from __future__ import annotations

import json
from pathlib import Path

from sc2tools_agent.state import (
    AgentState,
    count_synced,
    load_state,
    save_state,
)


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


# ---- v0.5.8 upload-pipeline overrides round-trip ---------------------


def test_upload_concurrency_override_round_trips(tmp_path: Path) -> None:
    """Settings-tab Upload concurrency saves to state and loads back
    intact, exactly like ``parse_concurrency_override``."""
    s = AgentState(
        device_token="t",
        upload_concurrency_override=3,
    )
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.upload_concurrency_override == 3


def test_upload_batch_size_override_round_trips(tmp_path: Path) -> None:
    """Settings-tab Upload batch size persists across restart."""
    s = AgentState(
        device_token="t",
        upload_batch_size_override=42,
    )
    save_state(tmp_path, s)
    loaded = load_state(tmp_path)
    assert loaded.upload_batch_size_override == 42


def test_upload_overrides_default_to_none_when_missing_from_disk(
    tmp_path: Path,
) -> None:
    """A state file written by v0.5.7 (before these fields existed)
    must load cleanly in v0.5.8 with the new fields defaulting to
    ``None`` — meaning ``cfg.upload_*`` falls back to the v0.5.8
    default values from ``load_config``."""
    raw = {
        "device_token": "t",
        "uploaded": {},
        "parse_concurrency_override": 4,
        # NO upload_concurrency_override / upload_batch_size_override
    }
    (tmp_path / "agent.json").write_text(json.dumps(raw))
    loaded = load_state(tmp_path)
    assert loaded.upload_concurrency_override is None
    assert loaded.upload_batch_size_override is None
    # Pre-existing field still respected.
    assert loaded.parse_concurrency_override == 4


# ---------------- count_synced --------------------------------------
#
# Feeds the dashboard's "Synced" stat card. The number must reflect
# only replays that actually reached the cloud — sentinel markers in
# ``state.uploaded`` ("filtered" / "rejected" / "skipped[:<reason>]")
# track files the agent deliberately did NOT ship and must not count.


def test_count_synced_counts_only_dated_entries() -> None:
    s = AgentState(
        uploaded={
            "a.SC2Replay": "2026-06-10T19:45:00+00:00",
            "b.SC2Replay": "2026-06-10T19:46:00+00:00",
            "c.SC2Replay": "filtered",
            "d.SC2Replay": "rejected",
            "e.SC2Replay": "skipped",
            "f.SC2Replay": "skipped:ai_game",
            "g.SC2Replay": "skipped:parse_failed",
            "h.SC2Replay": "skipped:resumed_replay",
        },
    )
    assert count_synced(s) == 2


def test_count_synced_empty_state_is_zero() -> None:
    assert count_synced(AgentState()) == 0


def test_count_synced_ignores_internal_marker_keys() -> None:
    """Pre-0.14 updaters wrote _release_seen_<channel> markers into
    ``uploaded``; they must not count as synced replays."""
    s = AgentState(
        uploaded={
            "a.SC2Replay": "2026-06-10T19:45:00+00:00",
            "_release_seen_stable": "0.13.2",
        },
    )
    assert count_synced(s) == 1


def test_load_state_migrates_legacy_release_seen_markers(
    tmp_path: Path,
) -> None:
    """Legacy in-``uploaded`` markers move to the dedicated
    ``release_seen`` field on load, healing the inflated Synced stat."""
    (tmp_path / "agent.json").write_text(
        json.dumps(
            {
                "uploaded": {
                    "a.SC2Replay": "2026-06-10T19:45:00+00:00",
                    "_release_seen_stable": "0.13.2",
                },
            },
        ),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)
    assert "_release_seen_stable" not in loaded.uploaded
    assert loaded.release_seen == {"stable": "0.13.2"}
    assert count_synced(loaded) == 1


def test_save_state_tolerates_concurrent_uploaded_writes(
    tmp_path: Path,
) -> None:
    """The watcher's threads mark entries in ``state.uploaded`` without
    the upload queue's lock while save_state serialises the dataclass;
    a resize mid-``asdict`` used to raise RuntimeError and fail the
    batch's state commit. save_state now snapshots with a retry."""
    import threading

    s = AgentState(uploaded={f"seed{i}.SC2Replay": "filtered" for i in range(50)})
    stop = threading.Event()

    def writer() -> None:
        # Insert + delete a rotating window of keys: forces continual
        # dict resizes (what triggers the RuntimeError) WITHOUT growing
        # the dict unboundedly — an earlier version of this test let
        # the dict grow hot-loop-fast and each save serialised the
        # ever-larger dict, ballooning the test to minutes and GBs.
        i = 0
        while not stop.is_set():
            s.uploaded[f"w{i % 512}.SC2Replay"] = "filtered"
            stale = f"w{(i + 256) % 512}.SC2Replay"
            s.uploaded.pop(stale, None)
            i += 1

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    try:
        for _ in range(50):
            save_state(tmp_path, s)  # must never raise RuntimeError
    finally:
        stop.set()
        t.join(timeout=2)
    assert (tmp_path / "agent.json").exists()


def test_load_state_reads_auto_update_flag(tmp_path: Path) -> None:
    (tmp_path / "agent.json").write_text(
        json.dumps({"auto_update_enabled": False}),
        encoding="utf-8",
    )
    assert load_state(tmp_path).auto_update_enabled is False
    # Default (absent key) is enabled.
    (tmp_path / "agent.json").write_text(json.dumps({}), encoding="utf-8")
    assert load_state(tmp_path).auto_update_enabled is True


def test_upload_overrides_garbage_inputs_load_as_none(
    tmp_path: Path,
) -> None:
    """A hand-edited state file with non-integer junk in either field
    must not crash ``load_state`` — `_coerce_int` returns ``None``
    on anything that doesn't parse cleanly, and the agent falls
    back to the config default."""
    raw = {
        "device_token": "t",
        "uploaded": {},
        "upload_concurrency_override": "not-a-number",
        "upload_batch_size_override": [1, 2, 3],
    }
    (tmp_path / "agent.json").write_text(json.dumps(raw))
    loaded = load_state(tmp_path)
    assert loaded.upload_concurrency_override is None
    assert loaded.upload_batch_size_override is None
