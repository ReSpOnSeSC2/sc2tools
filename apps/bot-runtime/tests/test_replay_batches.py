"""Scheduling tests use durations only; they never start StarCraft II."""

import pytest

from scripts.import_replay_batches import balanced_batches


def test_long_matches_are_balanced_without_duplicate_or_missing_replays():
    durations = [36, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]
    entries = [{"path": str(i), "duration_seconds": value * 60} for i, value in enumerate(durations)]
    batches = balanced_batches(entries, 4)
    assert sorted(e["path"] for batch in batches for e in batch) == sorted(e["path"] for e in entries)
    totals = [sum(e["duration_seconds"] for e in batch) for batch in batches]
    # This fixture attains the lower bound imposed by its single longest match.
    assert max(totals) == max(durations) * 60
    assert batches[0][0] == entries[0]
    assert balanced_batches(entries, 4) == batches


def test_missing_durations_fall_back_to_even_disjoint_batches():
    entries = [{"path": str(i)} for i in range(11)]
    assert sorted(map(len, balanced_batches(entries, 4))) == [2, 3, 3, 3]
    assert balanced_batches(entries[:1], 4) == [entries[:1]]
    with pytest.raises(ValueError):
        balanced_batches(entries, 5)
