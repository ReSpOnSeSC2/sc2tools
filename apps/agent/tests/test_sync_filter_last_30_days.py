from datetime import datetime, timedelta, timezone

from sc2tools_agent.sync_filter import PRESET_LAST_30_DAYS, SyncFilter


def test_last_thirty_utc_dates_roll_with_the_clock():
    current = datetime(2026, 11, 11, 14, tzinfo=timezone.utc)
    replay_filter = SyncFilter.from_state(PRESET_LAST_30_DAYS, None, None)
    since, until = replay_filter.resolve(now=current)
    assert since == datetime(2026, 10, 13, tzinfo=timezone.utc)
    assert until == datetime(2026, 11, 11, 23, 59, 59, 999999, tzinfo=timezone.utc)
    assert replay_filter.short_label() == "last 30 days"
    assert replay_filter.replay_in_range(since.isoformat(), now=current)
    assert not replay_filter.replay_in_range((since - timedelta(seconds=1)).isoformat(), now=current)
    assert replay_filter.resolve(now=current + timedelta(days=1))[0] == since + timedelta(days=1)
