"""Tests for sc2tools_agent.sync_filter — date-range upload gate.

The filter mirrors the website's date-preset bar so the agent and web
speak the same vocabulary. These tests pin down:

  * Each preset resolves to the right (since, until) tuple.
  * Boundary checks: replays exactly at the season start/end are
    included, replays a millisecond outside are excluded.
  * The mtime pre-check has a 7-day slack window on either side so
    files with skewed timestamps (OneDrive sync, restored backups)
    don't get incorrectly hidden.
  * Malformed presets and dates fall back to "all" (i.e. include
    everything) rather than silently hiding the streamer's replays.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from sc2tools_agent.sync_filter import (
    ANCHOR_SEASON,
    ANCHOR_START,
    MTIME_SLACK,
    SEASON_LENGTH,
    SyncFilter,
    current_season,
)


# A reference moment we control — pinned mid-Season-67 (anchor).
NOW = datetime(2026, 5, 8, 12, 0, 0, tzinfo=timezone.utc)


def test_default_preset_is_all_no_filter() -> None:
    f = SyncFilter()
    assert f.preset == "all"
    assert f.is_active() is False
    assert f.resolve(now=NOW) == (None, None)
    # Both checks return True for any input.
    assert f.mtime_in_range(0.0, now=NOW) is True
    assert f.replay_in_range("1999-01-01T00:00:00Z", now=NOW) is True


def test_current_season_resolves_to_anchor_window() -> None:
    f = SyncFilter.from_state(
        preset="current_season", since_iso=None, until_iso=None,
    )
    since, until = f.resolve(now=NOW)
    assert since is not None and until is not None
    # Mid-anchor-season → window starts at anchor.
    assert since == ANCHOR_START
    # End is clamped to ``now`` while the season is in progress so we
    # never include future-dated bogus games.
    assert until == NOW


def test_specific_season_uses_anchored_offset() -> None:
    # Season 66 = one season before the anchor.
    f = SyncFilter.from_state(
        preset="season:66", since_iso=None, until_iso=None,
    )
    since, until = f.resolve(now=NOW)
    expected_start = ANCHOR_START - SEASON_LENGTH
    expected_end = ANCHOR_START - timedelta(milliseconds=1)
    assert since == expected_start
    assert until == expected_end


def test_replay_in_range_includes_inside_excludes_outside() -> None:
    f = SyncFilter.from_state(preset="season:66", since_iso=None, until_iso=None)
    inside = (ANCHOR_START - timedelta(days=10)).isoformat().replace("+00:00", "Z")
    before = (ANCHOR_START - SEASON_LENGTH - timedelta(seconds=1)).isoformat().replace(
        "+00:00", "Z",
    )
    after = ANCHOR_START.isoformat().replace("+00:00", "Z")  # boundary +1ms
    assert f.replay_in_range(inside, now=NOW) is True
    assert f.replay_in_range(before, now=NOW) is False
    # ANCHOR_START is the season-67 start, i.e. one ms past the
    # season-66 end — must be excluded.
    assert f.replay_in_range(after, now=NOW) is False


def test_custom_range_honors_both_bounds() -> None:
    f = SyncFilter.from_state(
        preset="custom",
        since_iso="2026-04-15",
        until_iso="2026-05-01",
    )
    inside = "2026-04-20T10:00:00Z"
    before = "2026-04-14T23:59:59Z"
    # ``until_iso`` is a YYYY-MM-DD string — interpreted as
    # end-of-day so a user-typed "2026-05-01" includes everything
    # played that day.
    last_second_of_day = "2026-05-01T23:59:00Z"
    after = "2026-05-02T00:00:01Z"
    assert f.replay_in_range(inside) is True
    assert f.replay_in_range(before) is False
    assert f.replay_in_range(last_second_of_day) is True
    assert f.replay_in_range(after) is False


def test_custom_with_only_since_is_open_ended() -> None:
    f = SyncFilter.from_state(
        preset="custom", since_iso="2026-04-15", until_iso=None,
    )
    assert f.replay_in_range("2099-01-01T00:00:00Z") is True
    assert f.replay_in_range("2026-04-14T23:59:59Z") is False


def test_custom_with_only_until_is_open_ended() -> None:
    f = SyncFilter.from_state(
        preset="custom", since_iso=None, until_iso="2026-05-01",
    )
    assert f.replay_in_range("1999-01-01T00:00:00Z") is True
    assert f.replay_in_range("2026-05-02T00:00:01Z") is False


def test_custom_with_no_anchors_falls_back_to_all() -> None:
    """A custom range with neither bound is a no-op — fall back to
    ``all`` so the user doesn't see a confusing "(custom)" label
    on logs/status when nothing's actually being filtered."""
    f = SyncFilter.from_state(
        preset="custom", since_iso=None, until_iso=None,
    )
    assert f.preset == "all"
    assert f.is_active() is False


def test_malformed_preset_falls_back_to_all() -> None:
    """A corrupt state file or a future-agent preset string we don't
    recognise must not silently hide replays."""
    f = SyncFilter.from_state(
        preset="; DROP TABLE replays;",
        since_iso=None, until_iso=None,
    )
    assert f.preset == "all"
    assert f.replay_in_range("1999-01-01T00:00:00Z") is True


def test_malformed_custom_dates_treated_as_open() -> None:
    """An unparseable since/until string is treated as 'no bound on
    that side' rather than silently hiding the replay."""
    f = SyncFilter.from_state(
        preset="custom", since_iso="not-a-date", until_iso="2026-05-01",
    )
    assert f.replay_in_range("1999-01-01T00:00:00Z") is True
    assert f.replay_in_range("2026-05-02T00:00:01Z") is False


def test_replay_in_range_includes_unparseable_dates() -> None:
    """If the parser returns a ``CloudGame`` we trust it. A stored
    ``date_iso`` that won't parse is more likely a malformed timestamp
    than a malicious skip — let the upload path see it."""
    f = SyncFilter.from_state(preset="season:66", since_iso=None, until_iso=None)
    assert f.replay_in_range("not-a-date") is True
    assert f.replay_in_range(None) is True
    assert f.replay_in_range("") is True


def test_mtime_pre_check_has_7_day_slack() -> None:
    """OneDrive sync and restored backups stamp the wrong mtime; the
    pre-check must err on the side of letting the file through to
    the post-parse check."""
    f = SyncFilter.from_state(
        preset="custom", since_iso="2026-04-15", until_iso="2026-05-01",
    )
    since = datetime(2026, 4, 15, tzinfo=timezone.utc)
    # Within slack — must include.
    just_outside = (since - timedelta(days=6)).timestamp()
    assert f.mtime_in_range(just_outside, now=NOW) is True
    # Beyond slack — exclude (saves the parse cost during a backfill).
    well_outside = (since - MTIME_SLACK - timedelta(days=1)).timestamp()
    assert f.mtime_in_range(well_outside, now=NOW) is False


def test_mtime_pre_check_garbage_input_includes() -> None:
    f = SyncFilter.from_state(
        preset="custom", since_iso="2026-04-15", until_iso=None,
    )
    # A sentinel mtime (e.g. -1 from a stat error) should let the file
    # through to the parser, which has authoritative information.
    assert f.mtime_in_range(-(1 << 62), now=NOW) is True


def test_current_season_function_matches_anchor_at_anchor_start() -> None:
    """At the anchor, ``current_season`` returns the anchor number."""
    assert current_season(now=ANCHOR_START) == ANCHOR_SEASON
    # One day before the anchor → previous season.
    just_before = ANCHOR_START - timedelta(days=1)
    assert current_season(now=just_before) == ANCHOR_SEASON - 1


def test_short_label_for_each_preset() -> None:
    assert SyncFilter().short_label() == "all time"
    assert (
        SyncFilter.from_state(
            preset="season:67", since_iso=None, until_iso=None,
        ).short_label()
        == "Season 67"
    )
    assert (
        SyncFilter.from_state(
            preset="custom", since_iso="2026-04-15", until_iso="2026-05-01",
        ).short_label()
        == "2026-04-15 → 2026-05-01"
    )


@pytest.mark.parametrize(
    "preset,expected",
    [
        ("all", False),
        ("current_season", True),
        ("season:66", True),
    ],
)
def test_is_active_reports_filter_narrowness(preset: str, expected: bool) -> None:
    f = SyncFilter.from_state(preset=preset, since_iso=None, until_iso=None)
    assert f.is_active() is expected
